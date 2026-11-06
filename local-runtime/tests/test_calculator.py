"""Fixed calculator tools restored from the original linz behavior (#83).

The original linz desktop shipped two fixed tools - the plain ``calculator``
expression evaluator and the ``aero_calculator`` aviation formulas - as pure
built-ins: no approval, no execution channel, output identical to the
original. The expected strings here come from that original behavior
(JS number semantics), used as the independent source of truth.
"""

import pytest

from core.calculator import evaluate_aero_arguments, evaluate_expression


def test_plain_precedence_and_parentheses() -> None:
    assert evaluate_expression("1 + 2 * 3") == "7"
    assert evaluate_expression("(1 + 2) * 3") == "9"


def test_plain_power_is_right_associative_in_both_spellings() -> None:
    assert evaluate_expression("2 ^ 3 ^ 2") == "512"
    assert evaluate_expression("2 ** 10") == "1024"
    assert evaluate_expression("2^0.5") == "1.4142135623730951"


def test_plain_division_and_remainder_match_original_semantics() -> None:
    assert evaluate_expression("10 / 4") == "2.5"
    assert evaluate_expression("5 % 3") == "2"
    # JS remainder keeps the dividend's sign; a floored modulo would
    # answer -1 here and break parity with the original tool.
    assert evaluate_expression("5 % -3") == "2"
    assert evaluate_expression("-5 % 3") == "-2"
    assert evaluate_expression("10 / 0") == "计算错误: 除以零"


def test_plain_numbers_format_like_the_original_runtime() -> None:
    # Integral results never carry ".0"; the shortest round-trip digits
    # are kept; exponential form starts at 1e21 and below 1e-6; -0 is "0".
    assert evaluate_expression("0.1 + 0.2") == "0.30000000000000004"
    assert evaluate_expression("10 ** 30") == "1e+30"
    assert evaluate_expression("1.5e-7") == "1.5e-7"
    assert evaluate_expression("0 * -1") == "0"
    assert evaluate_expression("1.5e3") == "1500"
    # Down to 1e-6 the original kept decimal notation where Python's
    # repr would switch to an exponent.
    assert evaluate_expression("1.789e-5") == "0.00001789"


def test_plain_unary_signs() -> None:
    assert evaluate_expression("-3 + 1") == "-2"
    assert evaluate_expression("-(2 + 3)") == "-5"


def test_plain_whitelisted_functions_and_constants() -> None:
    assert evaluate_expression("pow(2, 10)") == "1024"
    assert evaluate_expression("pow(2, 8)") == "256"
    assert evaluate_expression("ceil(1.2)") == "2"
    assert evaluate_expression("floor(1.9)") == "1"
    assert evaluate_expression("abs(-5)") == "5"
    # JS Math.round rounds halves toward positive infinity, not to even.
    assert evaluate_expression("round(2.5)") == "3"
    assert evaluate_expression("round(-2.5)") == "-2"
    assert evaluate_expression("sqrt(2) * sqrt(2)") == "2.0000000000000004"
    assert evaluate_expression("sin(0.1) * 180 / PI") == "5.720033428234348"
    assert evaluate_expression("pi * 2") == "6.283185307179586"
    assert evaluate_expression("π * 2") == "6.283185307179586"
    assert evaluate_expression("log(exp(1))") == "1"


def test_plain_original_example_expression() -> None:
    # The worked example from the original tool's own description.
    assert evaluate_expression("0.5 * 1.225 * 70**2 * 20 * 0.5") == "30012.5"


def test_plain_error_messages_match_the_original() -> None:
    assert evaluate_expression("1 +") == "计算错误: 意外的表达式结尾"
    assert evaluate_expression("") == "计算错误: 意外的表达式结尾"
    assert evaluate_expression("(1 + 2") == "计算错误: 缺少右括号"
    assert evaluate_expression("foo + 1") == "计算错误: 未识别的标识符: foo"
    assert evaluate_expression("1 & 2") == "计算错误: 不支持的字符: &"


def test_plain_non_finite_results_use_the_original_messages() -> None:
    # JS asin(2) is NaN: the original parser rejects it as 不是有效数值.
    assert evaluate_expression("asin(2)") == "计算错误: 计算结果不是有效数值"
    assert evaluate_expression("sqrt(-1)") == "计算错误: 计算结果不是有效数值"
    assert evaluate_expression("pow(-1, 0.5)") == "计算错误: 计算结果不是有效数值"
    # JS modulo by zero is NaN (the explicit 除以零 guard covers '/' only).
    assert evaluate_expression("7 % 0") == "计算错误: 计算结果不是有效数值"
    # JS log(0) is -Infinity: a number, so the infinity message applies.
    assert (
        evaluate_expression("log(0)")
        == "错误: 计算结果为无穷大或非数值，请检查输入参数"
    )


def test_plain_number_tokens_parse_like_the_original() -> None:
    # parseFloat("1.2.3") keeps the leading "1.2"; the original tokenizer
    # hands the whole run of digits/dots to parseFloat.
    assert evaluate_expression("1.2.3") == "1.2"


def test_plain_overflowing_functions_answer_infinity_like_the_original() -> None:
    # JS Math.exp(1000) is Infinity and floor/ceil keep it; the original
    # answered the infinity hint instead of crashing the tool.
    assert (
        evaluate_expression("exp(1000)")
        == "错误: 计算结果为无穷大或非数值，请检查输入参数"
    )
    assert (
        evaluate_expression("floor(exp(1000))")
        == "错误: 计算结果为无穷大或非数值，请检查输入参数"
    )
    # Infinity / Infinity is NaN in the original runtime.
    assert evaluate_expression("exp(1000) / exp(1000)") == "计算错误: 计算结果不是有效数值"


def test_plain_whitespace_skips_like_the_original() -> None:
    # JS /\s/ matches Unicode whitespace; a full-width space between the
    # tokens is skipped, not rejected as an unsupported character.
    assert evaluate_expression("1\u3000+\u30002") == "3"
    assert evaluate_expression("1﻿+2") == "3"


def test_aero_lift_with_defaults() -> None:
    assert (
        evaluate_aero_arguments(
            {"formula": "lift", "params": {"V": 70, "S": 20, "CL": 0.5}}
        )
        == "升力 L = 0.5 × 1.225 × 70² × 20 × 0.5 = 30012.5000 N"
    )


def test_aero_lift_missing_parameters() -> None:
    assert (
        evaluate_aero_arguments({"formula": "lift", "params": {"S": 20}})
        == "缺少必要参数: 升力计算需要 V(速度,m/s), S(参考面积,m²), "
        "CL(升力系数)，可选 rho(空气密度,kg/m³，默认1.225)"
    )


def test_aero_drag_with_explicit_density() -> None:
    assert (
        evaluate_aero_arguments(
            {"formula": "drag", "params": {"V": 70, "S": 20, "CD": 0.08, "rho": 1.0}}
        )
        == "阻力 D = 0.5 × 1 × 70² × 20 × 0.08 = 3920.0000 N"
    )


def test_aero_reynolds_message_keeps_original_number_formatting() -> None:
    # String(1.789e-5) is decimal "0.00001789" in the original runtime
    # (exponential starts below 1e-6), and Re is toExponential(4).
    assert (
        evaluate_aero_arguments(
            {"formula": "reynolds", "params": {"V": 70, "L_char": 0.1}}
        )
        == "雷诺数 Re = 1.225 × 70 × 0.1 / 0.00001789 = 4.7932e+5"
    )


def test_aero_reynolds_missing_parameters() -> None:
    assert (
        evaluate_aero_arguments({"formula": "reynolds", "params": {"V": 70}})
        == "缺少必要参数: 雷诺数计算需要 V(速度,m/s), L_char(特征长度,m)，"
        "可选 rho(空气密度,默认1.225), mu(动力粘度,默认1.789e-5 Pa·s)"
    )


def test_aero_mach_with_defaults() -> None:
    assert (
        evaluate_aero_arguments({"formula": "mach", "params": {"V": 85}})
        == "马赫数 M = 85 / 340.3 = 0.249780"
    )


def test_aero_mach_missing_parameters() -> None:
    assert (
        evaluate_aero_arguments({"formula": "mach", "params": {}})
        == "缺少必要参数: 马赫数计算需要 V(速度,m/s)，可选 a(音速,m/s，默认340.3)"
    )


def test_aero_dynamic_pressure() -> None:
    assert (
        evaluate_aero_arguments(
            {"formula": "dynamic_pressure", "params": {"V": 70}}
        )
        == "动压 q = 0.5 × 1.225 × 70² = 3001.2500 Pa"
    )


def test_aero_lift_to_drag() -> None:
    assert (
        evaluate_aero_arguments(
            {"formula": "lift_to_drag", "params": {"CL": 1.2, "CD": 0.08}}
        )
        == "升阻比 L/D = 1.2 / 0.08 = 15.0000"
    )


def test_aero_lift_to_drag_rejects_zero_cd() -> None:
    assert (
        evaluate_aero_arguments(
            {"formula": "lift_to_drag", "params": {"CL": 1.2, "CD": 0}}
        )
        == "缺少必要参数: 升阻比计算需要 CL(升力系数)和 CD(阻力系数)，且 CD 不能为0"
    )


def test_aero_wing_loading() -> None:
    assert (
        evaluate_aero_arguments(
            {"formula": "wing_loading", "params": {"W": 1200, "S": 20}}
        )
        == "翼载荷 W/S = 1200 / 20 = 60.0000 N/m²"
    )


def test_aero_to_fixed_tie_breaks_toward_the_larger_integer() -> None:
    # 1/32 = 0.03125 is exactly representable: the original's toFixed(4)
    # picks 313 ("0.0313"), Python's round-to-even would answer 0.0312.
    assert (
        evaluate_aero_arguments(
            {"formula": "wing_loading", "params": {"W": 1, "S": 32}}
        )
        == "翼载荷 W/S = 1 / 32 = 0.0313 N/m²"
    )


def test_aero_unknown_formula_lists_the_supported_set() -> None:
    assert (
        evaluate_aero_arguments({"formula": "foo", "params": {}})
        == "未知公式: foo。支持的公式: lift, drag, reynolds, mach, "
        "dynamic_pressure, lift_to_drag, wing_loading"
    )


def test_aero_original_json_string_input_is_accepted() -> None:
    # The original tool took one JSON string; the wire keeps accepting it.
    assert (
        evaluate_aero_arguments(
            {"input": '{"formula":"mach","params":{"V":85}}'}
        )
        == "马赫数 M = 85 / 340.3 = 0.249780"
    )


def test_aero_malformed_json_string_reports_the_parse_error() -> None:
    assert evaluate_aero_arguments({"input": "not json"}).startswith(
        "解析错误: 请提供有效的JSON输入。"
    )


def test_aero_missing_fields_report_the_format_error() -> None:
    assert (
        evaluate_aero_arguments({})
        == "输入格式错误: 需要 formula 和 params 字段"
    )
    assert (
        evaluate_aero_arguments({"formula": "lift"})
        == "输入格式错误: 需要 formula 和 params 字段"
    )
    assert (
        evaluate_aero_arguments({"input": "[1, 2]"})
        == "输入格式错误: 需要 formula 和 params 字段"
    )


def test_aero_non_numeric_params_are_a_malformed_payload() -> None:
    # The original coerced JS strings in arithmetic; the device refuses
    # the payload loudly instead of computing garbage.
    with pytest.raises(ValueError):
        evaluate_aero_arguments(
            {"formula": "mach", "params": {"V": "fast"}}
        )


def test_aero_zero_divisors_answer_infinity_like_the_original() -> None:
    # JS V/a with a=0 is Infinity (0/0 would be NaN); the original sent
    # the formatted word "Infinity" back as the result string.
    assert (
        evaluate_aero_arguments({"formula": "mach", "params": {"V": 100, "a": 0}})
        == "马赫数 M = 100 / 0 = Infinity"
    )
    assert (
        evaluate_aero_arguments({"formula": "wing_loading", "params": {"W": 1200, "S": 0}})
        == "翼载荷 W/S = 1200 / 0 = Infinity N/m²"
    )
    assert (
        evaluate_aero_arguments({"formula": "reynolds", "params": {"V": 70, "L_char": 0.1, "mu": 0}})
        == "雷诺数 Re = 1.225 × 70 × 0.1 / 0 = Infinity"
    )


def test_aero_infinite_results_format_like_the_original() -> None:
    # An overflowing magnitude is Infinity in the original runtime, and
    # its toFixed/toExponential render the word, not a crash.
    assert (
        evaluate_aero_arguments(
            {"formula": "lift", "params": {"V": 1e200, "S": 1e200, "CL": 1e200}}
        )
        == "升力 L = 0.5 × 1.225 × 1e+200² × 1e+200 × 1e+200 = Infinity N"
    )


def test_aero_huge_values_switch_to_exponential_to_fixed() -> None:
    # JS toFixed switches to the exponential String form at 1e21; the
    # quotient itself stays finite (1e308 / 340.3 ≈ 2.94e305).
    assert (
        evaluate_aero_arguments(
            {"formula": "mach", "params": {"V": 1e308}}
        )
        == "马赫数 M = 1e+308 / 340.3 = 2.9385836027034967e+305"
    )
