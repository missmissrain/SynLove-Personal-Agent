"""细发束重建：用受限三次样条替换指定范围的破碎细条，不处理头发主体与脸部。

rows/tris 为原主体顶点和三角形，曲线控制点以原模型坐标指定；
默认80截面、每截面10点、半径1.5毫米，保留附近原蒙皮。
"""
import numpy as np
from scipy.interpolate import CubicSpline
from scipy.spatial import cKDTree


class HairStrandBuilder:
    """移除头部外侧孤立发丝，仅重建下方保留的细发梢。"""

    def __init__(self, rows, tris):
        """rows 为原主体属性；tris 为原主体索引，均不在原对象上写回。"""
        self.rows = rows
        self.tris = tris

    def build_strands(self):
        """无参数；返回保留的主体索引、新发束属性与索引，以及精确移除计数。"""
        paths = [
            [(-.071,.028,.904),(-.079,.031,.883),(-.088,.034,.862),
             (-.092,.038,.842),(-.092,.039,.822),(-.092,.036,.802),(-.090,.031,.785)],
            [(-.132,.043,.669),(-.148,.043,.661),(-.163,.044,.652),
             (-.174,.043,.642),(-.175,.043,.631),(-.171,.044,.620)],
        ]
        faces = self.rows[self.tris, :3]
        centers = faces.mean(axis=1)
        remove = np.zeros(len(self.tris), dtype=bool)
        chunks, indices = [], []
        tree = cKDTree(self.rows[:, :3])
        cursor = 0
        for n, points in enumerate(paths):
            knots = np.array(points)
            params = np.r_[0, np.cumsum(np.linalg.norm(np.diff(knots, axis=0), axis=1))]
            params /= params[-1]
            t = np.linspace(0, 1, 80)
            spline = CubicSpline(params, knots, bc_type="natural")
            curve = spline(t)
            dist, _ = cKDTree(curve).query(centers)
            # 只移除完整落在细条邻域内的面，排除附近衣物和脸。
            if n == 0:
                region = (centers[:, 2] > .789) & (centers[:, 2] < .900)
                radius = .0065
            else:
                region = ((centers[:, 0] < -.133) & (centers[:, 2] > .625)
                          & (centers[:, 2] < .670) & (centers[:, 1] > .032))
                radius = .008
            remove |= region & (dist < radius)
            # 用户确认头部这根外悬发丝突兀：移除旧碎面，不再生成替代发丝。
            if n == 0:
                continue
            tangent = spline(t, 1)
            tangent /= np.maximum(np.linalg.norm(tangent, axis=1)[:, None], 1e-12)
            normal = np.cross(tangent, np.tile([0., 1., 0.], (len(t), 1)))
            normal /= np.maximum(np.linalg.norm(normal, axis=1)[:, None], 1e-12)
            side = np.cross(tangent, normal)
            for i, center in enumerate(curve):
                _, near = tree.query(center)
                for j in range(10):
                    row = self.rows[near].copy()
                    angle = 2*np.pi*j/10
                    size = (.00155 if n == 0 else .0013)
                    pos = center+size*(np.cos(angle)*normal[i]+np.sin(angle)*side[i])
                    row[:3] = pos
                    row[3:5] = [.454, .013]
                    row[5:23] = 0
                    row[23:26] = pos
                    row[26:30] = 1
                    # 清除脸部形态，绑定仍采用最近原发束的骨骼。
                    chunks.append(row)
                if i:
                    for j in range(10):
                        a, b = cursor+(i-1)*10+j, cursor+(i-1)*10+(j+1)%10
                        c, d = cursor+i*10+j, cursor+i*10+(j+1)%10
                        indices.extend([a,b,c,b,d,c])
            cursor += len(curve)*10
        return (self.tris[~remove].reshape(-1).astype("<u4"),
                np.array(chunks, dtype="<f4"), np.array(indices, dtype="<u4"),
                int(remove.sum()))
