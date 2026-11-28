"""KWS 训练器。

功能：读取 dataset.npz，按说话人划分训练/验证，训练 WakeModel，导出 best.pt 与 ONNX。
注册参数 config 为 KwsConfig；训练过程用 DQTM 进度条在 CMD 前台显示。
"""

import copy
import json
import time

import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader, TensorDataset

from kwsTraining.ProgressBar import DqtmBar
from kwsTraining.WakeModel import WakeModel


class Trainer:
    """负责训练、验证与导出。"""

    def __init__(self, config):
        """config 为 KwsConfig；自动选择 CUDA。"""
        self.config = config
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    def _load(self):
        """无参数；读取 npz 并返回训练/验证张量。"""
        data = np.load(str(self.config.data_dir / "dataset.npz"), allow_pickle=True)
        x = torch.from_numpy(data["X"].astype(np.float32)).unsqueeze(1)
        y = torch.from_numpy(data["y"].astype(np.int64))
        split = data["split"]
        train = split == "train"
        val = split == "val"
        return (x[train], y[train]), (x[val], y[val]), data

    def train(self):
        """无参数；训练并返回 best 指标。"""
        cfg = self.config
        (x_train, y_train), (x_val, y_val), data = self._load()
        print("DATA train=%d val=%d pos=%d" % (len(y_train), len(y_val), int(y_train.sum())),
              flush=True)
        pos = float(y_train.sum())
        neg = float(len(y_train) - pos)
        weight = torch.tensor([1.0, min(8.0, neg / max(1.0, pos))], device=self.device)
        model = WakeModel().to(self.device)
        optimizer = torch.optim.AdamW(model.parameters(), lr=cfg.learning_rate,
                                      weight_decay=1e-4)
        scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=cfg.epochs)
        loss_fn = nn.CrossEntropyLoss(weight=weight)
        loader = DataLoader(TensorDataset(x_train, y_train), batch_size=cfg.batch_size,
                            shuffle=True, num_workers=0, drop_last=False)
        best = {"recall": 0.0, "epoch": 0, "state": copy.deepcopy(model.state_dict())}
        for epoch in range(1, cfg.epochs + 1):
            model.train()
            bar = DqtmBar(len(loader), "epoch-%02d" % epoch)
            total_loss, seen = 0.0, 0
            for batch_x, batch_y in loader:
                batch_x, batch_y = batch_x.to(self.device), batch_y.to(self.device)
                batch_x = self._augment(batch_x)
                optimizer.zero_grad()
                logits = model(batch_x)
                loss = loss_fn(logits, batch_y)
                loss.backward()
                optimizer.step()
                total_loss += float(loss.item()) * batch_x.size(0)
                seen += batch_x.size(0)
                bar.update(1, "loss=%.4f" % (total_loss / max(1, seen)))
            bar.close()
            scheduler.step()
            metrics = self.evaluate(model, x_val, y_val)
            print("EPOCH %02d loss=%.4f val_auc=%.4f recall=%.3f fpr=%.3f" % (
                epoch, total_loss / max(1, seen), metrics["auc"], metrics["recall"],
                metrics["fpr"]), flush=True)
            if metrics["recall"] >= best["recall"]:
                best = {"recall": metrics["recall"], "epoch": epoch,
                        "auc": metrics["auc"], "fpr": metrics["fpr"],
                        "state": copy.deepcopy(model.state_dict())}
                torch.save(best["state"], str(cfg.model_dir / "best.pt"))
        model.load_state_dict(best["state"])
        self._calibrate(model, x_val, y_val)
        self.export(model)
        return best

    def _augment(self, x):
        """x 为 (B,1,40,120)；做轻微时间平移、频率/时间遮挡与噪声。"""
        batch = x.clone()
        for index in range(batch.size(0)):
            if torch.rand(1).item() < 0.5:
                shift = int(torch.randint(-2, 3, (1,)).item())
                batch[index] = torch.roll(batch[index], shifts=shift, dims=2)
            if torch.rand(1).item() < 0.3:
                width = int(torch.randint(1, 5, (1,)).item())
                start = int(torch.randint(0, 40 - width, (1,)).item())
                batch[index, :, start:start + width, :] = 0
            if torch.rand(1).item() < 0.3:
                width = int(torch.randint(1, 10, (1,)).item())
                start = int(torch.randint(0, 120 - width, (1,)).item())
                batch[index, :, :, start:start + width] = 0
        batch = batch + torch.randn_like(batch) * 0.03
        return batch

    def _calibrate(self, model, x, y):
        """model/x/y 为验证集；选 FPR≤1% 时召回最高的阈值并写 meta.json。"""
        scores = self._scores(model, x)
        label = y.numpy()
        best = {"threshold": 0.9, "recall": 0.0, "fpr": 0.0}
        for threshold in np.arange(0.30, 0.99, 0.01):
            recall = float(np.mean(scores[label == 1] >= threshold)) if int(label.sum()) else 0.0
            fpr = float(np.mean(scores[label == 0] >= threshold)) if int((label == 0).sum()) else 0.0
            if fpr <= 0.01 and recall > best["recall"]:
                best = {"threshold": float(round(threshold, 2)),
                        "recall": recall, "fpr": fpr}
        meta = {"threshold": best["threshold"], "valRecall": best["recall"],
                "valFpr": best["fpr"], "nMels": self.config.n_mels,
                "frames": self.config.frames, "windowSeconds": self.config.window_seconds,
                "hopSeconds": self.config.hop_seconds, "sampleRate": self.config.sample_rate}
        (self.config.model_dir / "meta.json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        print("CALIBRATE", meta, flush=True)
        return meta

    def _scores(self, model, x):
        """model/x 为验证数据；返回正类概率。"""
        model.eval()
        chunks = []
        with torch.no_grad():
            for start in range(0, len(x), 512):
                logits = model(x[start:start + 512].to(self.device))
                chunks.append(torch.softmax(logits, dim=1)[:, 1].cpu().numpy())
        return np.concatenate(chunks) if chunks else np.zeros(0)

    def evaluate(self, model, x, y):
        """model/x/y 为验证数据；返回 AUC、recall 与假阳性率。"""
        score = self._scores(model, x)
        label = y.numpy()
        positive = score[label == 1]
        negative = score[label == 0]
        recall = float(np.mean(positive >= self.config.threshold)) if positive.size else 0.0
        fpr = float(np.mean(negative >= self.config.threshold)) if negative.size else 0.0
        auc = self._auc(label, score)
        return {"auc": auc, "recall": recall, "fpr": fpr}

    def _auc(self, label, score):
        """label/score 为一维数组；返回 ROC AUC。"""
        if len(set(label.tolist())) < 2:
            return 0.5
        order = np.argsort(score)
        ranks = np.empty(len(score), dtype=np.float64)
        ranks[order] = np.arange(1, len(score) + 1)
        pos = label == 1
        count_pos = float(pos.sum())
        count_neg = float(len(label) - count_pos)
        return float((ranks[pos].sum() - count_pos * (count_pos + 1) / 2)
                     / max(1.0, count_pos * count_neg))

    def export(self, model):
        """model 为已训练网络；导出 ONNX 供终端推理。"""
        path = self.config.model_dir / "xinai-wake.onnx"
        model.eval().cpu()
        dummy = torch.zeros(1, 1, self.config.n_mels, self.config.frames)
        torch.onnx.export(model, dummy, str(path), opset_version=17,
                          input_names=["mel"], output_names=["logits"],
                          dynamic_axes={"mel": {0: "batch"}})
        print("EXPORT", path, path.stat().st_size, flush=True)
        return path
