"""中国劳动/租赁/实习相关法规的正则规则引擎。

设计原则（参考 us_ca.py）：
- 每条规则返回 StatuteCheck(rule_id, title, basis, status, detail, quote)
- status 只有三种：VIOLATION / OK / UNKNOWN（无命中绝不静默通过）
- 一条规则可能涉及多种文本写法的多分支处理
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from engine.models import StatuteCheck, StatuteStatus


# 加载法条数据库
_RULES_DB_PATH = Path(__file__).parent.parent / "data" / "cn_law_rules.json"
with open(_RULES_DB_PATH, "r", encoding="utf-8") as f:
    _RULES_DB = json.load(f)


def _excerpt(text: str, needle: str, span: int = 60) -> str:
    """Clip a readable excerpt around a matched phrase."""
    idx = text.find(needle)
    if idx < 0:
        return needle
    start = max(0, idx - 10)
    end = min(len(text), idx + len(needle) + span)
    return text[start:end].strip()


def _extract_number(text: str, pattern: str) -> float | None:
    """Extract first number matching pattern from text."""
    m = re.search(pattern, text, re.IGNORECASE)
    if m:
        # Find first group with digits
        for g in m.groups():
            if g and g.replace(",", "").replace(".", "").isdigit():
                return float(g.replace(",", ""))
    return None


def _sentences(text: str) -> list[str]:
    """Split text into sentences."""
    return re.split(r"(?<=[.!?。！？])\s+", text)


# ============================================================================
# P0 — 租房合同必查
# ============================================================================


def check_rent_deposit_cap(text: str, lang: str = "zh") -> StatuteCheck:
    """押金不超过月租金一倍。"""
    rule = _RULES_DB["rules"]["rent_deposit_cap"]
    rule_id = rule["rule_id"]
    title = rule["title"]
    basis = f"{rule['law']} {rule['article']}"

    # 尝试提取押金和月租金额
    deposit = _extract_number(text, r"押金[：:\s]*([0-9,]+)\s*元")
    if deposit is None:
        deposit = _extract_number(text, r"保证金[：:\s]*([0-9,]+)\s*元")
    
    rent = _extract_number(text, r"月租[金：:\s]*([0-9,]+)\s*元")
    if rent is None:
        rent = _extract_number(text, r"租金[：:\s]*([0-9,]+)\s*元/月")

    if deposit is not None and rent is not None:
        if deposit > rent:
            return StatuteCheck(
                rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.VIOLATION,
                detail=f"押金{deposit:.0f}元超过月租金{rent:.0f}元，超出部分不合理",
                quote=_excerpt(text, f"押金") if "押金" in text else _excerpt(text, f"保证金"),
            )
        return StatuteCheck(
            rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.OK,
            detail=f"押金{deposit:.0f}元未超过月租金{rent:.0f}元，符合合理范围",
            quote=_excerpt(text, f"押金") if "押金" in text else _excerpt(text, f"保证金"),
        )

    # 尝试文字描述（如"两个月押金"）
    m = re.search(r"押金[^.。]{0,30}?([一二三四五六两\d]+)\s*个月", text, re.IGNORECASE)
    if m:
        months_str = m.group(1)
        months_map = {"一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6}
        months = months_map.get(months_str, int(months_str) if months_str.isdigit() else 0)
        if months > 1:
            return StatuteCheck(
                rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.VIOLATION,
                detail=f"押金设置为{months}个月租金，超过1个月合理上限",
                quote=_excerpt(text, m.group(0)),
            )
        return StatuteCheck(
            rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.OK,
            detail=f"押金设置为{months}个月租金，符合合理范围",
            quote=_excerpt(text, m.group(0)),
        )

    return StatuteCheck(
        rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.UNKNOWN,
        detail="未找到明确的押金和月租金额，无法判断",
        quote="",
    )


def check_no_double_pledge(text: str, lang: str = "zh") -> StatuteCheck:
    """押金+定金不超过2个月租金。"""
    rule = _RULES_DB["rules"]["no_double_pledge"]
    rule_id = rule["rule_id"]
    title = rule["title"]
    basis = f"{rule['law']} {rule['article']}"

    deposit = _extract_number(text, r"押金[：:\s]*([0-9,]+)\s*元")
    advance = _extract_number(text, r"定金[：:\s]*([0-9,]+)\s*元")
    rent = _extract_number(text, r"月租[金：:\s]*([0-9,]+)\s*元")

    if deposit is not None and advance is not None and rent is not None:
        total = deposit + advance
        limit = rent * 2
        if total > limit:
            return StatuteCheck(
                rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.VIOLATION,
                detail=f"押金{deposit:.0f}元 + 定金{advance:.0f}元 = {total:.0f}元，超过月租金{rent:.0f}元的2倍（{limit:.0f}元）",
                quote=_excerpt(text, "押金") if "押金" in text else _excerpt(text, "定金"),
            )
        return StatuteCheck(
            rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.OK,
            detail=f"押金{deposit:.0f}元 + 定金{advance:.0f}元 = {total:.0f}元，未超过月租金2倍（{limit:.0f}元）",
            quote=_excerpt(text, "押金") if "押金" in text else _excerpt(text, "定金"),
        )

    return StatuteCheck(
        rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.UNKNOWN,
        detail="未找到明确的押金、定金和月租金额，无法判断",
        quote="",
    )


def check_deposit_refund_days(text: str, lang: str = "zh") -> StatuteCheck:
    """退押金期限不超过30天。"""
    rule = _RULES_DB["rules"]["deposit_refund_days"]
    rule_id = rule["rule_id"]
    title = rule["title"]
    basis = f"{rule['law']} {rule['article']}"

    # 匹配多种写法：退还押金X天 / X天内退还押金 / 退还押金...X天
    m = re.search(r"(?:退还|返还|退回)押金[^\d]{0,20}?([0-9]+)\s*(?:天|日|工作日)", text)
    if not m:
        m = re.search(r"([0-9]+)\s*(?:天|日|工作日)[^\d]{0,20}?(?:退还|返还|退回)押金", text)
    if not m:
        m = re.search(r"(?:退还|返还|退回)[^\d]{0,20}?([0-9]+)\s*(?:天|日|工作日)", text)
    if m:
        days = int(m.group(1))
        if days > 30:
            return StatuteCheck(
                rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.VIOLATION,
                detail=f"退押金期限为{days}天，超过30天合理期限",
                quote=_excerpt(text, m.group(0)),
            )
        return StatuteCheck(
            rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.OK,
            detail=f"退押金期限为{days}天，符合30天内合理期限",
            quote=_excerpt(text, m.group(0)),
        )

    return StatuteCheck(
        rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.UNKNOWN,
        detail="未找到明确的退押金期限条款",
        quote="",
    )


def check_unilateral_right_terminate(text: str, lang: str = "zh") -> StatuteCheck:
    """房东单方解约权限制。"""
    rule = _RULES_DB["rules"]["unilateral_right_terminate"]
    rule_id = rule["rule_id"]
    title = rule["title"]
    basis = f"{rule['law']} {rule['article']}"

    text_lower = text.lower()
    for marker in rule["negative_markers"]:
        if marker in text_lower:
            return StatuteCheck(
                rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.VIOLATION,
                detail=f"合同赋予房东单方随时解约权（{marker}），违反公平原则",
                quote=_excerpt(text, marker),
            )

    # 更灵活的匹配：(甲方|房东|出租方) + 有权随时 + (解除|终止)
    m = re.search(r"(?:甲方|房东|出租方|出租人)[^有]{0,10}?有权随时[^解终]{0,5}?(?:解除|终止)", text)
    if m:
        return StatuteCheck(
            rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.VIOLATION,
            detail="合同赋予房东单方随时解约权，违反公平原则",
            quote=_excerpt(text, m.group(0)),
        )

    return StatuteCheck(
        rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.OK,
        detail="未发现房东单方随时解约权条款",
        quote="",
    )


def check_repair_obligation(text: str, lang: str = "zh") -> StatuteCheck:
    """维修义务归属。"""
    rule = _RULES_DB["rules"]["repair_obligation"]
    rule_id = rule["rule_id"]
    title = rule["title"]
    basis = f"{rule['law']} {rule['article']}"

    text_lower = text.lower()
    for marker in rule["positive_markers"]:
        if marker in text_lower:
            return StatuteCheck(
                rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.OK,
                detail=f"合同明确维修义务归属：{marker}",
                quote=_excerpt(text, marker),
            )

    # 更灵活的正面匹配：出租方/甲方 + 负责/承担 + 维修
    if re.search(r"(?:出租方|出租人|甲方)[^维]{0,15}?(?:负责|承担)[^维]{0,5}?维修", text):
        return StatuteCheck(
            rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.OK,
            detail="合同明确维修义务由出租方承担",
            quote=_excerpt(text, "维修"),
        )

    # 检查是否有反向条款（承租方承担维修）
    if re.search(r"(?:承租方|乙方|承租人在)[^维]{0,15}?(?:负责|承担)[^维]{0,5}?维修", text):
        return StatuteCheck(
            rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.VIOLATION,
            detail="合同要求承租方承担维修责任，违反民法典第七百一十二条",
            quote=_excerpt(text, "维修"),
        )
    # 反向：维修 + 由 + 承租方/乙方
    if re.search(r"维修[^由]{0,10}?由[^承乙]{0,5}?(?:承租方|乙方)", text):
        return StatuteCheck(
            rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.VIOLATION,
            detail="合同要求承租方承担维修责任，违反民法典第七百一十二条",
            quote=_excerpt(text, "维修"),
        )

    return StatuteCheck(
        rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.UNKNOWN,
        detail="未找到明确的维修义务条款",
        quote="",
    )


def check_hidden_fees(text: str, lang: str = "zh") -> StatuteCheck:
    """隐形费用检测。"""
    rule = _RULES_DB["rules"]["hidden_fees"]
    rule_id = rule["rule_id"]
    title = rule["title"]
    basis = f"{rule['law']} {rule['article']}"

    found_fees = []
    for marker in rule["negative_markers"]:
        if marker in text:
            # 检查是否有明确金额
            pattern = rf"{marker}[^\d]{{0,20}}?([0-9,]+)\s*元"
            if not re.search(pattern, text):
                found_fees.append(marker)

    if found_fees:
        return StatuteCheck(
            rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.VIOLATION,
            detail=f"合同中存在未明示金额的隐形费用：{', '.join(found_fees)}",
            quote=_excerpt(text, found_fees[0]),
        )

    return StatuteCheck(
        rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.OK,
        detail="未发现未明示金额的隐形费用",
        quote="",
    )


# ============================================================================
# P1 — 实习/劳动合同必查
# ============================================================================


def check_probation_wage_80(text: str, lang: str = "zh") -> StatuteCheck:
    """试用期工资不低于约定工资的80%。"""
    rule = _RULES_DB["rules"]["probation_wage_80"]
    rule_id = rule["rule_id"]
    title = rule["title"]
    basis = f"{rule['law']} {rule['article']}"

    # 提取试用期工资（支持"试用期工资为3000元"等写法）
    trial_salary = _extract_number(text, r"试用期工资[^\d]{0,5}?([0-9,]+)\s*元")
    if trial_salary is None:
        trial_salary = _extract_number(text, r"试用期[^元\d]{0,10}?([0-9,]+)\s*元")

    # 提取转正/约定工资（支持"约定为5000元"等写法）
    full_salary = _extract_number(text, r"(?:转正|正式|约定)[^\d]{0,5}?([0-9,]+)\s*元")
    if full_salary is None:
        full_salary = _extract_number(text, r"月薪[^\d]{0,5}?([0-9,]+)\s*元")

    if trial_salary is not None and full_salary is not None and full_salary > 0:
        ratio = trial_salary / full_salary
        if ratio < 0.8:
            return StatuteCheck(
                rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.VIOLATION,
                detail=f"试用期工资{trial_salary:.0f}元仅为转正工资{full_salary:.0f}元的{ratio:.0%}，低于法定80%底线",
                quote=_excerpt(text, "试用期工资") if "试用期工资" in text else _excerpt(text, f"{trial_salary:.0f}元"),
            )
        return StatuteCheck(
            rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.OK,
            detail=f"试用期工资{trial_salary:.0f}元为转正工资{full_salary:.0f}元的{ratio:.0%}，符合法定80%底线",
            quote=_excerpt(text, "试用期工资") if "试用期工资" in text else _excerpt(text, f"{trial_salary:.0f}元"),
        )

    return StatuteCheck(
        rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.UNKNOWN,
        detail="未找到明确的试用期工资和转正工资金额，无法判断",
        quote="",
    )


def check_trial_period_limit(text: str, lang: str = "zh") -> StatuteCheck:
    """试用期期限上限。"""
    rule = _RULES_DB["rules"]["trial_period_limit"]
    rule_id = rule["rule_id"]
    title = rule["title"]
    basis = f"{rule['law']} {rule['article']}"

    # 提取合同期限（转换为月数）
    contract_months = None
    m = re.search(r"合同期限[：:\s]*([0-9]+)\s*年", text)
    if m:
        contract_months = int(m.group(1)) * 12
    else:
        m = re.search(r"合同期限[：:\s]*([0-9]+)\s*(?:个月|月)", text)
        if m:
            contract_months = int(m.group(1))

    # 提取试用期（月数）
    trial_months = None
    m = re.search(r"试用期[：:\s]*([0-9]+)\s*(?:个月|月)", text)
    if m:
        trial_months = int(m.group(1))

    if contract_months is not None and trial_months is not None:
        # 根据法定上限判断
        max_trial = 0
        if contract_months < 3:
            max_trial = 0
        elif contract_months < 12:
            max_trial = 1
        elif contract_months < 36:
            max_trial = 2
        else:
            max_trial = 6

        if trial_months > max_trial:
            return StatuteCheck(
                rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.VIOLATION,
                detail=f"合同期限{contract_months}个月，试用期{trial_months}个月，超过法定上限{max_trial}个月",
                quote=_excerpt(text, f"试用期") if "试用期" in text else _excerpt(text, f"{trial_months}个月"),
            )
        return StatuteCheck(
            rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.OK,
            detail=f"合同期限{contract_months}个月，试用期{trial_months}个月，符合法定上限{max_trial}个月",
            quote=_excerpt(text, f"试用期") if "试用期" in text else _excerpt(text, f"{trial_months}个月"),
        )

    return StatuteCheck(
        rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.UNKNOWN,
        detail="未找到明确的合同期限和试用期期限，无法判断",
        quote="",
    )


def check_overtime_weekday_150(text: str, lang: str = "zh") -> StatuteCheck:
    """工作日加班费不低于150%。"""
    rule = _RULES_DB["rules"]["overtime_weekday_150"]
    rule_id = rule["rule_id"]
    title = rule["title"]
    basis = f"{rule['law']} {rule['article']}"

    m = re.search(r"工作日加班[^\d]{0,20}?([0-9]+)\s*%|延长工作时间[^\d]{0,20}?([0-9]+)\s*%", text)
    if m:
        rate = int(m.group(1) or m.group(2))
        if rate < 150:
            return StatuteCheck(
                rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.VIOLATION,
                detail=f"工作日加班费率为{rate}%，低于法定150%底线",
                quote=_excerpt(text, m.group(0)),
            )
        return StatuteCheck(
            rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.OK,
            detail=f"工作日加班费率为{rate}%，符合法定150%底线",
            quote=_excerpt(text, m.group(0)),
        )

    return StatuteCheck(
        rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.UNKNOWN,
        detail="未找到明确的工作日加班费率条款",
        quote="",
    )


def check_overtime_weekend_200(text: str, lang: str = "zh") -> StatuteCheck:
    """周末加班费不低于200%。"""
    rule = _RULES_DB["rules"]["overtime_weekend_200"]
    rule_id = rule["rule_id"]
    title = rule["title"]
    basis = f"{rule['law']} {rule['article']}"

    m = re.search(r"周末加班[^\d]{0,20}?([0-9]+)\s*%|休息日加班[^\d]{0,20}?([0-9]+)\s*%", text)
    if m:
        rate = int(m.group(1) or m.group(2))
        if rate < 200:
            return StatuteCheck(
                rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.VIOLATION,
                detail=f"周末加班费率为{rate}%，低于法定200%底线",
                quote=_excerpt(text, m.group(0)),
            )
        return StatuteCheck(
            rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.OK,
            detail=f"周末加班费率为{rate}%，符合法定200%底线",
            quote=_excerpt(text, m.group(0)),
        )

    return StatuteCheck(
        rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.UNKNOWN,
        detail="未找到明确的周末加班费率条款",
        quote="",
    )


def check_overtime_holiday_300(text: str, lang: str = "zh") -> StatuteCheck:
    """法定节假日加班费不低于300%。"""
    rule = _RULES_DB["rules"]["overtime_holiday_300"]
    rule_id = rule["rule_id"]
    title = rule["title"]
    basis = f"{rule['law']} {rule['article']}"

    m = re.search(r"法定节假日加班[^\d]{0,20}?([0-9]+)\s*%|节假日加班[^\d]{0,20}?([0-9]+)\s*%", text)
    if m:
        rate = int(m.group(1) or m.group(2))
        if rate < 300:
            return StatuteCheck(
                rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.VIOLATION,
                detail=f"法定节假日加班费率为{rate}%，低于法定300%底线",
                quote=_excerpt(text, m.group(0)),
            )
        return StatuteCheck(
            rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.OK,
            detail=f"法定节假日加班费率为{rate}%，符合法定300%底线",
            quote=_excerpt(text, m.group(0)),
        )

    return StatuteCheck(
        rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.UNKNOWN,
        detail="未找到明确的法定节假日加班费率条款",
        quote="",
    )


def check_social_insurance_mandatory(text: str, lang: str = "zh") -> StatuteCheck:
    """用人单位必须依法缴纳社会保险。"""
    rule = _RULES_DB["rules"]["social_insurance_mandatory"]
    rule_id = rule["rule_id"]
    title = rule["title"]
    basis = f"{rule['law']} {rule['article']}"

    text_lower = text.lower()
    for marker in rule["negative_markers"]:
        if marker in text_lower:
            return StatuteCheck(
                rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.VIOLATION,
                detail=f"合同中存在排除社保缴纳的条款：{marker}",
                quote=_excerpt(text, marker),
            )

    # 检查是否有正面条款
    if "缴纳社保" in text_lower or "社会保险" in text_lower:
        return StatuteCheck(
            rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.OK,
            detail="合同明确约定社保缴纳义务",
            quote=_excerpt(text, "社保") if "社保" in text else _excerpt(text, "社会保险"),
        )

    return StatuteCheck(
        rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.UNKNOWN,
        detail="未找到明确的社保缴纳条款",
        quote="",
    )


def check_noncompensate_min(text: str, lang: str = "zh") -> StatuteCheck:
    """竞业限制补偿金下限。"""
    rule = _RULES_DB["rules"]["noncompensate_min"]
    rule_id = rule["rule_id"]
    title = rule["title"]
    basis = f"{rule['law']} {rule['article']}"

    text_lower = text.lower()
    has_noncompete = any(marker in text_lower for marker in rule["negative_markers"])

    if has_noncompete:
        # 检查是否提及补偿金
        if "补偿金" in text_lower or "补偿" in text_lower:
            return StatuteCheck(
                rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.OK,
                detail="合同约定竞业限制并提及补偿金",
                quote=_excerpt(text, "竞业限制") if "竞业限制" in text else _excerpt(text, "补偿金"),
            )
        else:
            return StatuteCheck(
                rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.VIOLATION,
                detail="合同约定竞业限制但未明确补偿金标准",
                quote=_excerpt(text, "竞业限制") if "竞业限制" in text else _excerpt(text, "竞业禁止"),
            )

    return StatuteCheck(
        rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.OK,
        detail="合同未约定竞业限制条款",
        quote="",
    )


def check_working_hours_max(text: str, lang: str = "zh") -> StatuteCheck:
    """工作时间不超过法定上限。"""
    rule = _RULES_DB["rules"]["working_hours_max"]
    rule_id = rule["rule_id"]
    title = rule["title"]
    basis = f"{rule['law']} {rule['article']}"

    # 提取日工作时长
    daily_hours = _extract_number(text, r"(?:工作|上班|工时)[^\d]{0,10}?([0-9]+)\s*(?:小时|h|H)")
    
    # 提取周工作时长
    weekly_hours = _extract_number(text, r"每周[^\d]{0,10}?([0-9]+)\s*(?:小时|h|H)")
    if weekly_hours is None:
        # 尝试从日工作时长推算
        if daily_hours is not None:
            days_per_week = _extract_number(text, r"每周[^\d]{0,10}?([0-9]+)\s*(?:天|日)")
            if days_per_week is not None:
                weekly_hours = daily_hours * days_per_week

    if daily_hours is not None or weekly_hours is not None:
        violations = []
        if daily_hours is not None and daily_hours > 8:
            violations.append(f"日工作{daily_hours:.0f}小时超过8小时")
        if weekly_hours is not None and weekly_hours > 44:
            violations.append(f"周工作{weekly_hours:.0f}小时超过44小时")

        if violations:
            return StatuteCheck(
                rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.VIOLATION,
                detail=f"工作时间超过法定上限：{'; '.join(violations)}",
                quote=_excerpt(text, f"{daily_hours:.0f}小时") if daily_hours else _excerpt(text, f"{weekly_hours:.0f}小时"),
            )
        return StatuteCheck(
            rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.OK,
            detail=f"工作时间符合法定上限（日{daily_hours:.0f}小时/周{weekly_hours:.0f}小时）" if daily_hours and weekly_hours else "工作时间符合法定上限",
            quote=_excerpt(text, f"{daily_hours:.0f}小时") if daily_hours else _excerpt(text, f"{weekly_hours:.0f}小时"),
        )

    return StatuteCheck(
        rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.UNKNOWN,
        detail="未找到明确的工作时间条款",
        quote="",
    )


def check_vacation_entitlement(text: str, lang: str = "zh") -> StatuteCheck:
    """带薪年休假权利。"""
    rule = _RULES_DB["rules"]["vacation_entitlement"]
    rule_id = rule["rule_id"]
    title = rule["title"]
    basis = f"{rule['law']} {rule['article']}"

    text_lower = text.lower()
    for marker in rule["negative_markers"]:
        if marker in text_lower:
            return StatuteCheck(
                rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.VIOLATION,
                detail=f"合同中存在剥夺年假权利的条款：{marker}",
                quote=_excerpt(text, marker),
            )

    # 更灵活的匹配：不享受 + (有?)年假/带薪休假
    if re.search(r"不享受[^\n]{0,5}?(?:年假|带薪休假)", text):
        return StatuteCheck(
            rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.VIOLATION,
            detail="合同中存在剥夺年假权利的条款",
            quote=_excerpt(text, "不享受"),
        )
    # 无年假 / 无带薪休假
    if re.search(r"无[^\n]{0,3}?(?:年假|带薪休假)", text):
        return StatuteCheck(
            rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.VIOLATION,
            detail="合同中存在剥夺年假权利的条款",
            quote=_excerpt(text, "无"),
        )

    # 检查是否有正面条款
    if "年假" in text_lower or "带薪休假" in text_lower:
        return StatuteCheck(
            rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.OK,
            detail="合同明确约定带薪年休假权利",
            quote=_excerpt(text, "年假") if "年假" in text else _excerpt(text, "带薪休假"),
        )

    return StatuteCheck(
        rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.UNKNOWN,
        detail="未找到明确的年休假条款",
        quote="",
    )


# ============================================================================
# P2 — NDA/保密协议必查
# ============================================================================


def check_nda_scope_reasonable(text: str, lang: str = "zh") -> StatuteCheck:
    """保密范围合理性。"""
    rule = _RULES_DB["rules"]["nda_scope_reasonable"]
    rule_id = rule["rule_id"]
    title = rule["title"]
    basis = f"{rule['law']} {rule['article']}"

    text_lower = text.lower()
    found_issues = []
    for marker in rule["negative_markers"]:
        if marker in text_lower:
            found_issues.append(marker)

    if found_issues:
        return StatuteCheck(
            rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.VIOLATION,
            detail=f"保密范围包含不合理内容：{', '.join(found_issues)}",
            quote=_excerpt(text, found_issues[0]),
        )

    return StatuteCheck(
        rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.OK,
        detail="保密范围合理，未包含公开信息",
        quote="",
    )


def check_nda_duration_reasonable(text: str, lang: str = "zh") -> StatuteCheck:
    """保密期限合理性。"""
    rule = _RULES_DB["rules"]["nda_duration_reasonable"]
    rule_id = rule["rule_id"]
    title = rule["title"]
    basis = f"{rule['law']} {rule['article']}"

    text_lower = text.lower()
    for marker in rule["negative_markers"]:
        if marker in text_lower:
            return StatuteCheck(
                rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.VIOLATION,
                detail=f"保密期限为无限期（{marker}），超出合理范围",
                quote=_excerpt(text, marker),
            )

    # 检查是否有明确期限
    m = re.search(r"保密期限[^\d]{0,10}?([0-9]+)\s*年", text)
    if m:
        years = int(m.group(1))
        if years > 5:
            return StatuteCheck(
                rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.VIOLATION,
                detail=f"保密期限为{years}年，超过5年合理范围",
                quote=_excerpt(text, m.group(0)),
            )
        return StatuteCheck(
            rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.OK,
            detail=f"保密期限为{years}年，符合合理范围",
            quote=_excerpt(text, m.group(0)),
        )

    return StatuteCheck(
        rule_id=rule_id, title=title, basis=basis, status=StatuteStatus.UNKNOWN,
        detail="未找到明确的保密期限条款",
        quote="",
    )


# ============================================================================
# 统一调用接口
# ============================================================================


def run_all_rental_checks(text: str, lang: str = "zh") -> list[StatuteCheck]:
    """运行所有租房合同检查。"""
    return [
        check_rent_deposit_cap(text, lang),
        check_no_double_pledge(text, lang),
        check_deposit_refund_days(text, lang),
        check_unilateral_right_terminate(text, lang),
        check_repair_obligation(text, lang),
        check_hidden_fees(text, lang),
    ]


def run_all_employment_checks(text: str, lang: str = "zh") -> list[StatuteCheck]:
    """运行所有劳动/实习合同检查。"""
    return [
        check_probation_wage_80(text, lang),
        check_trial_period_limit(text, lang),
        check_overtime_weekday_150(text, lang),
        check_overtime_weekend_200(text, lang),
        check_overtime_holiday_300(text, lang),
        check_social_insurance_mandatory(text, lang),
        check_noncompensate_min(text, lang),
        check_working_hours_max(text, lang),
        check_vacation_entitlement(text, lang),
    ]


def run_all_nda_checks(text: str, lang: str = "zh") -> list[StatuteCheck]:
    """运行所有NDA/保密协议检查。"""
    return [
        check_nda_scope_reasonable(text, lang),
        check_nda_duration_reasonable(text, lang),
    ]


def run_all_checks(text: str, contract_type: str = "unknown", lang: str = "zh") -> list[StatuteCheck]:
    """根据合同类型运行相应检查。"""
    checks = []
    
    if contract_type in ("rental", "lease", "unknown"):
        checks.extend(run_all_rental_checks(text, lang))
    
    if contract_type in ("employment", "internship", "unknown"):
        checks.extend(run_all_employment_checks(text, lang))
    
    if contract_type in ("nda", "unknown"):
        checks.extend(run_all_nda_checks(text, lang))
    
    return checks
