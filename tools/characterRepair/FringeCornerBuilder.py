"""发尾缺角补面：补齐指定刘海右缘到既有尖端之间的曲面，不再延长尖端。

参数 rows 为已精修刘海属性；默认24个纵向截面、每截面8格。
补面使用原头发的干净取样与骨骼，只覆盖已定位的缺角区域。
"""
import numpy as np


class FringeCornerBuilder:
    """用两条连续二次曲线连接刘海根部与既有尖端，填完整缺失的三角角部。"""

    def __init__(self, rows):
        """rows 为精修后的局部属性，仅读取目标发束以确定尖端及蒙皮。"""
        self.rows = rows

    def build_patch(self):
        """无参数；返回独立补面的顶点属性与局部索引，尖端与既有网格重合。"""
        mask = np.linalg.norm(
            self.rows[:, 19:21] - [.68356574, .37675184], axis=1) < 1e-5
        source = self.rows[mask]
        tip = source[np.argmin(source[:, 2]), :3].copy()
        left = np.array([-.0280, -.0700, .8875])
        right = np.array([-.0232, -.0705, .8890])
        left_control = np.array([-.0282, -.0665, .8790])
        right_control = np.array([-.0230, -.0660, .8770])
        values, faces = [], []
        height, width = 24, 8
        for i in range(height):
            t = i / height
            lo = (1-t)**2*left + 2*t*(1-t)*left_control + t*t*tip
            hi = (1-t)**2*right + 2*t*(1-t)*right_control + t*t*tip
            for j in range(width+1):
                u = j / width
                pos = lo*(1-u) + hi*u
                pos[1] -= .0003*np.sin(np.pi*u)*np.sin(np.pi*t)
                near = source[np.argmin(np.linalg.norm(source[:, :3]-pos, axis=1))]
                row = near.copy()
                row[:3] = pos
                row[3:5] = [.68356574, .37675184]
                row[5:19] = 0
                row[19:21] = [.68356574, .37675184]
                # 负遮罩标记只属于补面；第二分量记录横向位置，用于连续右缘描边。
                row[21:23] = [-1, u]
                row[23:26] = pos
                values.append(row)
                if i and j:
                    a = (i-1)*(width+1)+j-1
                    b, c, d = a+1, a+width+1, a+width+2
                    faces.extend((a, c, b, b, c, d))
        # 用单一尖端封口，避免最后一排重合顶点留下退化面和缺口。
        row = source[np.argmin(source[:, 2])].copy()
        row[3:5] = [.68356574, .37675184]
        row[5:19] = 0
        row[21:23] = [-1, 1]
        end = len(values)
        values.append(row)
        start = (height-1)*(width+1)
        for j in range(width):
            faces.extend((start+j, end, start+j+1))
        return np.asarray(values, dtype="<f4"), np.asarray(faces, dtype="<u4")
