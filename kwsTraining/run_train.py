"""KWS 训练入口。

功能：解析命令行，串起数据生成、训练、导出与评测；
注册参数：--generate/--train/--eval/--all、--limit-sids、--limit-sentences、--epochs、--wav。
所有阶段都在 CMD 前台输出并写 runtime/kwsTraining/train.log。
"""

import argparse
import io
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from kwsTraining.DatasetBuilder import DatasetBuilder
from kwsTraining.Evaluator import Evaluator
from kwsTraining.KwsConfig import KwsConfig
from kwsTraining.Trainer import Trainer
from kwsTraining.TtsSynthesizer import TtsSynthesizer


def log_handle(config):
    """config 为 KwsConfig；返回追加写日志的文件句柄。"""
    return io.open(config.log_dir / "train.log", "a", encoding="utf-8")


def main():
    """无参数；按命令行执行训练阶段。"""
    parser = argparse.ArgumentParser(description="欣爱 KWS 训练")
    parser.add_argument("--generate", action="store_true", help="生成数据集")
    parser.add_argument("--train", action="store_true", help="训练并导出")
    parser.add_argument("--eval", action="store_true", help="评测测试集与真实录音")
    parser.add_argument("--all", action="store_true", help="生成+训练+评测")
    parser.add_argument("--limit-sids", type=int, default=None)
    parser.add_argument("--limit-sentences", type=int, default=None)
    parser.add_argument("--epochs", type=int, default=None)
    parser.add_argument("--wav", default=str(Path(__file__).resolve().parents[1] / "runtime" / "kwsTraining" / "live_probe.wav"))
    parser.add_argument("--positive-start", type=float, default=10.0)
    parser.add_argument("--positive-end", type=float, default=12.5)
    args = parser.parse_args()

    config = KwsConfig(ROOT)
    if args.epochs:
        config.epochs = args.epochs
    handle = log_handle(config)

    def emit(text):
        """text 为一行日志；同时写 CMD 与文件。"""
        print(text, flush=True)
        handle.write(text + "\n")
        handle.flush()

    emit("START %s" % time.strftime("%Y-%m-%d %H:%M:%S"))
    if args.all:
        args.generate = args.train = args.eval = True
    if args.generate:
        synth = TtsSynthesizer(config)
        builder = DatasetBuilder(config, synth)
        stats = builder.build(args.limit_sids, args.limit_sentences)
        emit("DATASET " + json.dumps(stats, ensure_ascii=False))
    if args.train:
        trainer = Trainer(config)
        best = trainer.train()
        handle.write("BEST %s\n" % {k: v for k, v in best.items() if k != "state"})
        emit("BEST epoch=%s recall=%.3f auc=%.4f fpr=%.3f" % (
            best["epoch"], best["recall"], best.get("auc", 0), best.get("fpr", 0)))
    if args.eval:
        evaluator = Evaluator(config)
        emit("TEST " + json.dumps(evaluator.evaluate_dataset(), ensure_ascii=False))
        if Path(args.wav).is_file():
            result = evaluator.evaluate_wav(args.wav, (args.positive_start, args.positive_end))
            emit("WAV " + json.dumps(result, ensure_ascii=False))
    emit("DONE %s" % time.strftime("%Y-%m-%d %H:%M:%S"))
    handle.close()


if __name__ == "__main__":
    main()
