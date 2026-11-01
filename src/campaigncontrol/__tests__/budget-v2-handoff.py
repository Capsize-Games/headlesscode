import json, os, sys
from contextlib import ExitStack
from unittest.mock import patch
import operations.campaign_budget as budget
import operations.campaign_budget_bridge as bridge
import operations.campaign_control as control
month = os.environ.get("FLEET_TEST_MONTH")
crash_after_admit = os.environ.get("FLEET_TEST_CRASH_AFTER_ADMIT") == "1"
def fixed_control(path, **kwargs):
    with open(path, "r", encoding="utf-8") as stream: value = json.load(stream)
    if month: value["month"] = month
    return value
patches = [patch.object(budget, "_provider_snapshot",
        return_value={"limit_micros": 5000000, "remaining_micros": 5000000,
        "usage_micros": 0})]
if crash_after_admit:
    original = bridge.FleetBudgetBridge._repository_request_start
    def crash_after_request_start(self, message):
        result = original(self, message)
        os._exit(79)
    bridge.FleetBudgetBridge._repository_request_start = crash_after_request_start
if month:
    patches.extend([patch.object(budget, "_utc_month", return_value=month),
        patch.object(budget, "read_control", side_effect=fixed_control),
        patch.object(control, "read_control", side_effect=fixed_control),
        patch.object(bridge, "read_control", side_effect=fixed_control)])
with patches[0]:
    with ExitStack() as stack:
        for item in patches[1:]: stack.enter_context(item)
        bridge.main()
