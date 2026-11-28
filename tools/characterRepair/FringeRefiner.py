"""刘海局部曲面精修：细分已确认的独立刘海网格，修顺轮廓并收细发尖。

参数 rows/tris 为原模型属性和三角索引；仅匹配现有 hairUv 分岛，
不处理脸、眼睛与其他发束。默认三轮细分，根部边界保持原位。
"""
import numpy as np
from FringeCornerBuilder import FringeCornerBuilder


class FringeRefiner:
    """通过局部拓扑细分、受限平滑与渐进收尖消除低面数刘海的方块轮廓。"""

    def __init__(self, rows, tris):
        """rows 为只读原属性；tris 为尚未移除刘海的三角形索引。"""
        self.rows = rows
        self.tris = np.asarray(tris).reshape(-1, 3)

    def refine_fringe(self):
        """无参数；返回保留索引、独立精修顶点和索引，以及实际处理统计。"""
        selected = np.linalg.norm(
            self.rows[:, 19:21] - [.68356574, .37675184], axis=1) < 1e-5
        main = np.all(selected[self.tris], axis=1)
        # 相邻细刘海横跨多个UV小岛，采用严格空间范围并排除嘴眼形态顶点。
        p = self.rows
        side = ((p[:, 0] > -.022) & (p[:, 0] < -.010) & (p[:, 1] < -.062)
                & (p[:, 2] > .874) & (p[:, 2] < .916)
                & (np.max(np.abs(p[:, 5:14]), axis=1) < 1e-8))
        mask = main | np.all(side[self.tris], axis=1)
        faces = self.tris[mask]
        ids, inverse = np.unique(faces, return_inverse=True)
        rows = self.rows[ids].copy()
        faces = inverse.reshape(-1, 3)
        for _ in range(3):
            rows, faces = self.subdivide_patch(rows, faces)
        # 只在发梢收窄，根部不移动；收尖中心沿原发束方向渐进弯曲。
        z = rows[:, 2].copy()
        t = np.clip((.895 - z) / .020, 0, 1)
        t = t * t * (3 - 2 * t)
        t *= (np.linalg.norm(rows[:, 19:21] - [.68356574, .37675184], axis=1) < 1e-5)
        center = -.0290 + .0015 * t
        rows[:, 0] = center + (rows[:, 0] - center) * (1 - .60 * t)
        self.extend_tip(rows)
        # 该分岛已确认是头发，禁止继承原网格误带的眼皮肤色与睫毛补色。
        rows[:, 14:19] = 0
        # 与原始位置属性同步，避免材质遮罩与几何位置分离。
        rows[:, 23:26] = rows[:, :3]
        corner, corner_indices = FringeCornerBuilder(rows).build_patch()
        corner_indices += len(rows)
        faces = np.concatenate((faces.reshape(-1), corner_indices)).reshape(-1, 3)
        rows = np.concatenate((rows, corner))
        return (self.tris[~mask].reshape(-1).astype("<u4"),
                rows.astype("<f4"), faces.reshape(-1).astype("<u4"),
                {"removedTriangles": int(mask.sum()), "vertices": len(rows),
                 "triangles": len(faces), "iterations": 3,
                 "mainTipTriangles": int(main.sum()),
                 "adjacentStrandTriangles": int((mask & ~main).sum()),
                 "tipExtension": .003, "cornerPatchTriangles": len(corner_indices)//3})

    def extend_tip(self, rows):
        """rows 为局部细分属性；沿原发束延长3毫米并连续收拢到尖端，根部不变。"""
        mask = np.linalg.norm(rows[:, 19:21] - [.68356574, .37675184], axis=1) < 1e-5
        z = rows[mask, 2].copy()
        t = np.clip((.886 - z) / (.886 - z.min()), 0, 1)
        strength = t ** 2.2
        rows[mask, 0] += (-.0264 - rows[mask, 0]) * strength
        rows[mask, 1] += (-.0625 - rows[mask, 1]) * strength
        rows[mask, 2] -= .003 * t ** 1.7

    def subdivide_patch(self, rows, faces):
        """rows/faces 为当前局部属性与面；细分一轮并在焊接位置空间平滑内部。"""
        values = list(rows.copy())
        edges = {}
        split = []
        for a, b, c in faces:
            mids = []
            for x, y in ((a, b), (b, c), (c, a)):
                key = tuple(sorted((int(x), int(y))))
                if key not in edges:
                    value = (rows[x] + rows[y]) * .5
                    # 骨骼编号为离散数据，禁止插值成不存在的骨骼编号。
                    if not np.array_equal(rows[x, 30:34], rows[y, 30:34]):
                        value[30:38] = rows[x, 30:38]
                    else:
                        value[30:34] = rows[x, 30:34]
                    edges[key] = len(values)
                    values.append(value)
                mids.append(edges[key])
            ab, bc, ca = mids
            split.extend(((a, ab, ca), (ab, b, bc), (ca, bc, c), (ab, bc, ca)))
        result = np.asarray(values, dtype="<f4")
        split = np.asarray(split, dtype="<u4")
        points, inverse = np.unique(np.round(result[:, :3], 7), axis=0,
                                    return_inverse=True)
        welded = inverse[split]
        edge_list = np.sort(np.concatenate((welded[:, [0, 1]], welded[:, [1, 2]],
                                          welded[:, [2, 0]])), axis=1)
        edge_list, counts = np.unique(edge_list, axis=0, return_counts=True)
        boundary = set(np.unique(edge_list[counts == 1]).tolist())
        neighbors = [set() for _ in points]
        for a, b in edge_list:
            neighbors[a].add(b)
            neighbors[b].add(a)
        moved = points.copy()
        for i, near in enumerate(neighbors):
            if i in boundary or not near:
                continue
            strength = np.clip((.906 - points[i, 2]) / .012, 0, 1) * .42
            moved[i] += strength * (points[list(near)].mean(axis=0) - points[i])
        result[:, :3] += (moved - points)[inverse]
        result[:, 23:26] = result[:, :3]
        return result, split
