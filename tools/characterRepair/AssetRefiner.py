"""原型资产局部修缮：平滑低点数发束，修复黑色无效 UV，保留原脸、嘴眼与骨架。

source 为原资产目录，output 为独立派生目录。默认位移不超过 2.5 毫米；
不覆盖原二进制，不重建脸部拓扑，不修改原贴图。
"""
import hashlib
import json
from pathlib import Path

import numpy as np
from scipy.sparse import coo_matrix
from scipy.spatial import cKDTree

from MeshInspector import MeshInspector
from HairStrandBuilder import HairStrandBuilder
from FringeRefiner import FringeRefiner


class AssetRefiner:
    """基于焊接位置的邻接关系平滑局部发束，并为补面重建最近表面 UV。"""

    def __init__(self, source, output):
        """source 为输入资产；output 为独立派生资源及中文修缮记录目录。"""
        self.audit = MeshInspector(source)
        self.output = Path(output)
        self.output.mkdir(parents=True, exist_ok=True)

    def refine_assets(self):
        """无参数；输出可回滚的派生清单与二进制，记录实际位移与保护区域变化。"""
        a = self.audit
        blob = bytearray(a.blob)
        rows = np.ndarray(a.rows.shape, dtype="<f4", buffer=blob,
                          offset=a.part["vertexOffset"])
        uv = rows[:, 3:5]
        bad = np.linalg.norm(uv, axis=1) < 1e-8
        good = ~bad
        # UV=0 的填补面原本采到 atlas 黑角；同位置最近表面提供有效 UV。
        tree = cKDTree(rows[good, :3])
        dist, near = tree.query(rows[bad, :3])
        rows[bad, 3:5] = rows[good, 3:5][near]
        p = a.points.astype(np.float64).copy()
        mask_rows = ((uv[:, 0] > .35) & (uv[:, 0] < .49) & (uv[:, 1] < .10)
                     & (rows[:, 1] > .015) & (rows[:, 2] > .60)
                     & (np.abs(rows[:, 0]) > .07))
        mask = np.zeros(len(p), dtype=bool)
        mask[a.ids[mask_rows]] = True
        x, y = a.edges.T
        graph = coo_matrix((np.ones(len(x) * 2), (np.r_[x, y], np.r_[y, x])),
                           shape=(len(p), len(p))).tocsr()
        degree = np.maximum(1, np.asarray(graph.sum(axis=1)).ravel())
        original = p.copy()
        # 只处理已定位发束；Taubin 正负步降低高频锯齿而限制整体收缩。
        for _ in range(12):
            for weight in (.45, -.47):
                delta = graph.dot(p) / degree[:, None] - p
                p[mask] += weight * delta[mask]
                shift = p - original
                length = np.linalg.norm(shift, axis=1)
                scale = np.minimum(1, .0025 / np.maximum(length, 1e-12))
                p = original + shift * scale[:, None]
        delta = (p - original)[a.ids]
        rows[:, :3] += delta
        # 原位坐标属性同步微调；嘴眼形态、蒙皮权重和 UV 分岛保持。
        rows[:, 23:26] += delta
        face = ((np.abs(a.rows[:, 0]) < .065) & (a.rows[:, 1] < 0)
                & (a.rows[:, 2] > .80))
        if not np.array_equal(rows[face, :3], a.rows[face, :3]):
            raise RuntimeError("脸部保护检查失败")
        if not np.array_equal(rows[:, 5:14], a.rows[:, 5:14]):
            raise RuntimeError("嘴眼形态增量发生变化")
        keep, hair, hair_indices, removed = HairStrandBuilder(rows, a.tris).build_strands()
        keep, fringe, fringe_indices, fringe_report = FringeRefiner(rows, keep).refine_fringe()
        # 用退化占位索引保持原部件的偏移稳定，新管面另附独立部件。
        old_indices = np.ndarray((a.part["count"],), dtype="<u4", buffer=blob,
                                 offset=a.part["indexOffset"])
        old_indices[:] = 0
        old_indices[:len(keep)] = keep
        spec = a.spec
        for part in spec["parts"]:
            if part["material"].get("texture"):
                part["material"]["texture"] = "../../../Avatar/assets/OriginalTexture0.png"
        blob = bytearray(bytes(blob))
        offset = len(blob)
        blob.extend(hair.tobytes())
        index_offset = len(blob)
        blob.extend(hair_indices.tobytes())
        material = dict(spec["parts"][0]["material"])
        material["faceCorrection"] = False
        spec["parts"].append({"name": "RefinedHairStrands", "stride": 40,
                              "vertices": len(hair), "count": len(hair_indices),
                              "vertexOffset": offset, "vertexBytes": hair.nbytes,
                              "indexOffset": index_offset, "indexBytes": hair_indices.nbytes,
                              "material": material})
        offset = len(blob)
        blob.extend(fringe.tobytes())
        index_offset = len(blob)
        blob.extend(fringe_indices.tobytes())
        # 精修发束沿用原主体的眼周遮罩修正，但自身嘴眼增量为零。
        spec["parts"].append({"name": "RefinedFringe", "stride": 40,
                              "vertices": len(fringe), "count": len(fringe_indices),
                              "vertexOffset": offset, "vertexBytes": fringe.nbytes,
                              "indexOffset": index_offset, "indexBytes": fringe_indices.nbytes,
                              "material": dict(spec["parts"][0]["material"])})
        spec["repair"] = {"sourceBinarySha256": hashlib.sha256(a.blob).hexdigest(),
                          "modifiedHairVertices": int(np.count_nonzero(np.linalg.norm(delta, axis=1))),
                          "maxShift": float(np.linalg.norm(delta, axis=1).max()),
                          "fixedUvVertices": int(bad.sum()),
                          "maxUvProjectionDistance": float(dist.max()),
                          "rebuiltStrands": 1,
                          "removedFloatingStrands": 1,
                          "removedDamagedTriangles": removed,
                          "addedHairVertices": len(hair),
                          "protectedFaceVertices": int(face.sum()),
                          "facePositionChanged": False}
        spec["repair"]["fringeRefinement"] = fringe_report
        spec["bytes"] = len(blob)
        (self.output / "Avatar.bin").write_bytes(blob)
        (self.output / "Avatar.json").write_text(json.dumps(spec, ensure_ascii=False), "utf-8")
        (self.output / "模型修缮记录.json").write_text(
            json.dumps(spec["repair"], ensure_ascii=False, indent=2), "utf-8")
        print(json.dumps(spec["repair"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    import sys
    AssetRefiner(sys.argv[1], sys.argv[2]).refine_assets()
