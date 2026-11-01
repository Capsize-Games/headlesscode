import json, os, sys
from unittest.mock import patch
import operations.campaign_budget as budget
import operations.campaign_budget_bridge as bridge
import operations.campaign_control as control
month = os.environ.get("FLEET_TEST_MONTH")
fault = os.environ.get("FLEET_TEST_FAULT")
def fixed_control(path, **kwargs):
    with open(path, "r", encoding="utf-8") as stream: value = json.load(stream)
    if month: value["month"] = month
    return value
patches = [patch.object(budget, "_provider_snapshot",
        return_value={"limit_micros": 5000000, "remaining_micros": 5000000,
        "usage_micros": 0})]
if month:
    patches.extend([patch.object(budget, "_utc_month", return_value=month),
        patch.object(budget, "read_control", side_effect=fixed_control),
        patch.object(control, "read_control", side_effect=fixed_control),
        patch.object(bridge, "read_control", side_effect=fixed_control)])
if fault == "settle-after":
    original = budget.BudgetAuthority.settle
    def settle_then_lose(self, **kwargs):
        result = original(self, **kwargs)
        if result: raise OSError("fixture lost settlement response after durable commit")
        return result
    patches.append(patch.object(budget.BudgetAuthority, "settle",
        settle_then_lose))
with patches[0]:
    from contextlib import ExitStack
    with ExitStack() as stack:
        for item in patches[1:]: stack.enter_context(item)
        print(json.dumps(bridge._authority().dispatch(json.load(sys.stdin)),
        separators=(",", ":")))
