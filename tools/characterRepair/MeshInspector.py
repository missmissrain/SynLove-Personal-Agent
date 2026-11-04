"""网格审查：焊接仅用于分析的重复位置，统计连通分量与边界。

参数 source 指向现有 Avatar 资产目录。只读二进制与清单，不改动原始模型。
"""
import json
from pathlib import Path

import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components


class MeshInspector:
    """以位置去重建立拓扑索引，定位小发束和局部开边。"""

    def __init__(self, source):
        """source 为清单和二进制所在目录；读取第一个原模型主体。"""
        self.source = Path(source)
        self.spec = json.loads((self.source / "Avatar.json").read_text("utf-8"))
        self.blob = (self.source / "Avatar.bin").read_bytes()
        self.part = self.spec["parts"][0]
        p = self.part
        self.rows = np.frombuffer(self.blob, "<f4", count=p["vertexBytes"] // 4,
                                  offset=p["vertexOffset"]).reshape(-1, p["stride"])
        self.tris = np.frombuffer(self.blob, "<u4", count=p["count"],
                                  offset=p["indexOffset"]).reshape(-1, 3)
        _, first, self.ids = np.unique(np.round(self.rows[:, :3], 6), axis=0,
                                      return_index=True, return_inverse=True)
        self.points = self.rows[first, :3]
        faces = self.ids[self.tris]
        self.edges = np.unique(np.sort(np.concatenate(
            [faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]]), axis=1), axis=0)
        a, b = self.edges.T
        graph = coo_matrix((np.ones(len(a) * 2), (np.r_[a, b], np.r_[b, a])),
                           shape=(len(first), len(first)))
        self.count, self.labels = connected_components(graph)

    def inspect_mesh(self):
        """无参数；打印较大的分量边界和大小，供几何修缮选择精确区域。"""
        sizes = np.bincount(self.labels)
        result = []
        for label in np.argsort(-sizes):
            if sizes[label] < 20:
                continue
            pts = self.points[self.labels == label]
            result.append({"id": int(label), "vertices": int(sizes[label]),
                           "min": pts.min(0).round(5).tolist(),
                           "max": pts.max(0).round(5).tolist()})
        print(json.dumps({"unique": len(self.points), "components": self.count,
                          "parts": result[:65]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    import sys
    MeshInspector(sys.argv[1]).inspect_mesh()
