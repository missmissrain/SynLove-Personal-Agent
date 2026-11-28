"""预演场景登记：读配置、按手机已装应用与已覆盖进度挑选本轮该探索的新内容。

参数 root 为个人实例仓库根目录；config 为配置文件路径（默认 config/rehearsal.json）。

注册参数：
- scenarios：场景列表，含 id/name/goal/apps/packages/skillName/variants。
- intervalHours：同一场景两次预演的最小间隔。
- exploration：探索策略。skipCoveredVariants 跳过已覆盖的变体；discoverFromInstalled 允许从未预演过的应用里发现新目标。
- forbidActions：不可逆动作关键词，命中就禁止执行并停在原地。
"""
import json
import os
import time
from pathlib import Path


class ScenarioRegistry:
    """场景清单、覆盖进度与挑选策略。"""

    def __init__(self, root, config=None):
        """root为仓库根目录，config为配置路径；缺省读 config/rehearsal.json。"""
        self.root = Path(root)
        self.path = Path(config) if config else self.root / "config" / "rehearsal.json"
        self.data = json.loads(self.path.read_text(encoding="utf-8-sig"))
        self.scenarios = [row for row in self.data.get("scenarios", []) if row.get("id")]
        self.exploration = self.data.get("exploration") or {}

    def state(self):
        """无参数；读取预演状态（每场景最后时间与已覆盖变体）。"""
        path = self.root / str(self.data.get("stateFile") or "runtime/rehearsal-state.json")
        if not path.is_file():
            return {}
        try:
            return json.loads(path.read_text(encoding="utf-8-sig"))
        except Exception:
            return {}

    def save_state(self, state):
        """state为要落盘的状态字典；写入成功返回 True。"""
        path = self.root / str(self.data.get("stateFile") or "runtime/rehearsal-state.json")
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, path)
        return True

    def find(self, key):
        """key为场景 id 或中文名；返回场景字典。"""
        for row in self.scenarios:
            if key in (row.get("id"), row.get("name")):
                return row
        return None

    def installed(self, packages):
        """packages为手机已装包名集合；返回其中可执行的场景列表。"""
        found = set(str(name) for name in (packages or []))
        picked = []
        for row in self.scenarios:
            wanted = [str(item) for item in row.get("packages", [])]
            if not wanted or any(item in found for item in wanted):
                picked.append(row)
        return picked

    def covered(self, scenario_id, state=None):
        """scenario_id为场景；返回该场景已经覆盖过的变体描述列表。"""
        data = state if state is not None else self.state()
        entry = data.get(scenario_id) or {}
        return [str(item) for item in (entry.get("covered") or [])]

    def next_variant(self, scenario, state=None):
        """scenario为场景；返回下一个尚未覆盖的变体描述，全部覆盖后返回 None。"""
        variants = [str(item) for item in scenario.get("variants", []) if str(item).strip()]
        if not variants or not self.exploration.get("skipCoveredVariants", True):
            return None
        done = set(self.covered(scenario["id"], state))
        for item in variants:
            if item not in done:
                return item
        return None

    def due(self, packages=None, state=None):
        """packages为已装包名；按最久没预演优先返回待办场景（含未覆盖变体的场景优先）。"""
        apps = self.installed(packages)
        data = state if state is not None else self.state()
        hours = float(self.data.get("intervalHours") or 24)
        now = time.time()
        rows = []
        for row in apps:
            last = float((data.get(row["id"]) or {}).get("at") or 0)
            if last and now - last < hours * 3600:
                continue
            # 变体全部覆盖过的场景排到后面，让没探索过的优先。
            fresh = 1 if self.next_variant(row, data) else 0
            rows.append((fresh, last, row))
        rows.sort(key=lambda item: (-item[0], item[1]))
        return [row for _, _, row in rows]

    def next_target(self, packages=None):
        """packages为已装包名；返回 {scenario, variant, reason} 或 None。"""
        state = self.state()
        apps = self.installed(packages)
        for row in apps:
            variant = self.next_variant(row, state)
            if variant is None:
                continue
            last = float((state.get(row["id"]) or {}).get("at") or 0)
            hours = float(self.data.get("intervalHours") or 24)
            if last and time.time() - last < hours * 3600:
                continue
            return {"scenario": row, "variant": variant,
                    "reason": "覆盖 %d/%d" % (len(self.covered(row["id"], state)),
                                              len(row.get("variants") or []))}
        # 所有固定场景都覆盖完：从未预演过的应用里找一个新目标。
        if self.exploration.get("discoverFromInstalled", True):
            survey = self.find("app-survey")
            if survey is not None:
                variant = self.next_variant(survey, state) or (survey.get("variants") or [""])[0]
                return {"scenario": survey, "variant": str(variant),
                        "reason": "固定场景已覆盖完，转向未探索应用",
                        "packages": sorted(packages or [])}
        return None

    def record(self, scenario_id, variant, delivery=None, extra=None):
        """scenario_id/variant为本次覆盖；delivery为注入编号；返回更新后的状态。"""
        state = self.state()
        entry = state.get(scenario_id) or {}
        covered = [str(item) for item in (entry.get("covered") or [])]
        if variant and variant not in covered:
            covered.append(variant)
        entry.update({"at": time.time(),
                      "text": time.strftime("%Y-%m-%d %H:%M:%S"),
                      "delivery": delivery,
                      "covered": covered,
                      "times": int(entry.get("times") or 0) + 1})
        if extra:
            entry.update(extra)
        state[scenario_id] = entry
        self.save_state(state)
        return state

    def mention_apps(self, scenario):
        """scenario为场景；返回给主人看的应用名描述。"""
        apps = scenario.get("apps") or []
        return "、".join(apps) if apps else "系统自带页面"
