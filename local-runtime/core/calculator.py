"""The fixed calculator tools restored from the original linz behavior (#83).

The original desktop shipped two fixed tools - the plain ``calculator``
expression evaluator and the ``aero_calculator`` aviation formulas - as pure
built-ins: no approval, no side effects, and no execution channel. This
module ports both verbatim (原版行为一致): the same recursive-descent
parser with its whitelist, the same seven aviation formulas, the same
Chinese messages, and the original runtime's number formatting (JS
``String(number)``, ``toFixed`` and ``toExponential`` semantics), because the
result strings are what the original users saw.

Everything here is a pure function from strings/dicts to strings. Nothing
reads the filesystem, spawns processes, opens sockets, or touches secrets:
the capability needs no consent and no session tier, and the original
calculator errors come back as result strings, exactly as before.
"""

from __future__ import annotations

import json
import math
import re
from decimal import Decimal
from typing import Any, Callable


def _js_asin(value: float) -> float:
    try:
        return math.asin(value)
    except (ValueError, TypeError):
        return float("nan")


def _js_acos(value: float) -> float:
    try:
        return math.acos(value)
    except (ValueError, TypeError):
        return float("nan")


def _js_sqrt(value: float) -> float:
    try:
        return math.sqrt(value)
    except (ValueError, TypeError):
        return float("nan")


def _js_log(value: float) -> float:
    # JS Math.log: log(±0) is -Infinity, log(negative) is NaN.
    if value == 0:
        return -math.inf
    try:
        return math.log(value)
    except (ValueError, TypeError):
        return float("nan")


def _js_log2(value: float) -> float:
    if value == 0:
        return -math.inf
    try:
        return math.log2(value)
    except (ValueError, TypeError):
        return float("nan")


def _js_log10(value: float) -> float:
    if value == 0:
        return -math.inf
    try:
        return math.log10(value)
    except (ValueError, TypeError):
        return float("nan")


def _js_pow(base: float, exponent: float) -> float:
    # JS Math.pow: 0^-n is Infinity, a negative base with a fractional
    # exponent is NaN, and an overflowing magnitude is ±Infinity.
    if base == 0 and exponent < 0:
        return math.inf
    try:
        return math.pow(base, exponent)
    except OverflowError:
        if base < 0 and exponent % 2 == 1:
            return -math.inf
        return math.inf
    except (ValueError, TypeError):
        return float("nan")


def _js_round(value: float) -> float:
    # JS Math.round rounds halves toward positive infinity, unlike Python's
    # round-to-even; floor(x + 0.5) is the original runtime's semantics.
    return float(math.floor(value + 0.5))


#: The original whitelist; anything else is rejected during tokenizing.
MATH_FUNCTIONS: dict[str, Callable[..., float]] = {
    "sin": math.sin,
    "cos": math.cos,
    "tan": math.tan,
    "asin": _js_asin,
    "acos": _js_acos,
    "atan": math.atan,
    "sqrt": _js_sqrt,
    "abs": abs,
    "log": _js_log,
    "log2": _js_log2,
    "log10": _js_log10,
    "exp": math.exp,
    "pow": _js_pow,
    "ceil": lambda value: float(math.ceil(value)),
    "floor": lambda value: float(math.floor(value)),
    "round": _js_round,
}

MATH_CONSTANTS: dict[str, float] = {"PI": math.pi, "E": math.e}


def _js_number_to_string(value: float) -> str:
    """Format a float the way the original runtime's ``String(number)`` did.

    Integral magnitudes below 1e21 print without a fractional part, the
    shortest round-trip decimal digits are kept, exponential notation starts
    at 1e21 and below 1e-6, and negative zero is plain ``0``.
    """
    if value == 0:
        return "0"
    if value.is_integer() and abs(value) < 1e21:
        return str(int(value))
    magnitude = abs(value)
    if 1e-6 <= magnitude < 1e21:
        # Python's repr switches to exponential below 1e-4 where the
        # original runtime kept decimal notation down to 1e-6.
        rendered = repr(value)
        if "e" not in rendered and "E" not in rendered:
            return rendered
        return _decimal_from_exponential(rendered)
    # repr already produced the shortest digits, only with Python's
    # zero-padded exponent ("1.5e-07"); re-render it without the padding.
    mantissa, _, exponent = repr(value).partition("e")
    if mantissa.endswith(".0"):
        mantissa = mantissa[:-2]
    sign = "-" if exponent.startswith("-") else "+"
    return f"{mantissa}e{sign}{int(exponent.lstrip('+-'))}"


def _decimal_from_exponential(rendered: str) -> str:
    """Expand Python's exponential repr to plain decimal notation.

    The shortest round-trip digits are preserved (``1.789e-05`` becomes
    ``0.00001789``), which is what the original runtime printed for this
    magnitude range.
    """
    mantissa, _, exponent_text = rendered.partition("e")
    exponent = int(exponent_text)
    negative = mantissa.startswith("-")
    digits = mantissa.lstrip("+-").replace(".", "")
    point = 1 + exponent
    if point <= 0:
        body = "0." + "0" * (-point) + digits
    elif point >= len(digits):
        body = digits + "0" * (point - len(digits))
    else:
        body = digits[:point] + "." + digits[point:]
    return ("-" if negative else "") + body


def _quantize_ties_up(scaled: Decimal) -> Decimal:
    """Round to the nearest integer; an exact tie picks the larger integer.

    That tie rule is what the original's ``toFixed``/``toExponential``
    specified, and it differs from round-to-even on exact ties.
    """
    floor_value = scaled.to_integral_value(rounding="ROUND_FLOOR")
    remainder = scaled - floor_value
    if remainder < Decimal("0.5"):
        return floor_value
    return floor_value + 1


def _js_to_fixed(value: float, digits: int) -> str:
    """Format like the original runtime's ``Number.toFixed``."""
    scale = Decimal(10) ** digits
    quantized = _quantize_ties_up(Decimal(value) * scale)
    return f"{quantized / scale:.{digits}f}"


def _js_to_exponential(value: float, digits: int) -> str:
    """Format like the original runtime's ``Number.toExponential``.

    Same tie rule as ``toFixed`` on the ``digits``-place mantissa, and the
    exponent carries a sign but no zero padding (``4.7926e+5``).
    """
    exact = Decimal(value)
    if exact == 0:
        return f"0.{'0' * digits}e+0"
    exponent = exact.adjusted()
    mantissa = _quantize_ties_up(exact.scaleb(-exponent) * Decimal(10) ** digits)
    rendered_mantissa = mantissa / Decimal(10) ** digits
    if rendered_mantissa >= 10:
        # The rounding carried into a new decade (9.99995 -> 10.0000).
        rendered_mantissa = rendered_mantissa / 10
        exponent += 1
    sign = "+" if exponent >= 0 else "-"
    return f"{rendered_mantissa:.{digits}f}e{sign}{abs(exponent)}"


def _parse_float(text: str) -> float:
    """Parse like the original runtime's ``parseFloat``.

    The longest valid numeric prefix is kept (``"1.2.3"`` is ``1.2``); an
    empty prefix is NaN, which the parser reports as an invalid number.
    """
    match = re.match(r"(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?", text)
    if match is None:
        return float("nan")
    return float(match.group(0))


_NAME_START = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_")
_NAME_CHARS = _NAME_START | set("0123456789")
_WHITESPACE = set(" \t\n\r\v\f")
_NUMBER_RUN = set("0123456789.eE+-")


class _ExpressionError(ValueError):
    """A parse or evaluation failure carrying the original's message."""


class _Token:
    __slots__ = ("type", "value")

    def __init__(self, type: str, value: str) -> None:
        self.type = type
        self.value = value


def _tokenize(expr: str) -> list[_Token]:
    tokens: list[_Token] = []
    i = 0
    while i < len(expr):
        ch = expr[i]
        if ch in _WHITESPACE:
            i += 1
            continue
        if ch in "0123456789.":
            num = ""
            while i < len(expr) and expr[i] in _NUMBER_RUN:
                # Handle scientific notation: only allow +/- after e/E
                if expr[i] in "+-" and len(num) > 0 and num[-1] not in "eE":
                    break
                num += expr[i]
                i += 1
            tokens.append(_Token("number", num))
        elif ch in "+-*/%^":
            tokens.append(_Token("operator", ch))
            i += 1
        elif ch == "(":
            tokens.append(_Token("lparen", ch))
            i += 1
        elif ch == ")":
            tokens.append(_Token("rparen", ch))
            i += 1
        elif ch == ",":
            tokens.append(_Token("comma", ch))
            i += 1
        elif ch in _NAME_START:
            name = ""
            while i < len(expr) and expr[i] in _NAME_CHARS:
                name += expr[i]
                i += 1
            if name in MATH_FUNCTIONS:
                tokens.append(_Token("function", name))
            elif name in MATH_CONSTANTS:
                tokens.append(_Token("constant", name))
            else:
                raise _ExpressionError(f"未识别的标识符: {name}")
        else:
            raise _ExpressionError(f"不支持的字符: {ch}")
    return tokens


class _Parser:
    def __init__(self, tokens: list[_Token]) -> None:
        self.tokens = tokens
        self.pos = 0

    def _peek(self) -> _Token | None:
        return self.tokens[self.pos] if self.pos < len(self.tokens) else None

    def _peek_ahead(self) -> _Token | None:
        return self.tokens[self.pos + 1] if self.pos + 1 < len(self.tokens) else None

    def _consume(self) -> _Token:
        token = self._peek()
        if token is None:
            raise _ExpressionError("意外的表达式结尾")
        self.pos += 1
        return token

    # expression = term (('+' | '-') term)*
    def parse(self) -> float:
        result = self._parse_term()
        while True:
            token = self._peek()
            if token is not None and token.type == "operator" and token.value in "+-":
                self._consume()
                right = self._parse_term()
                if token.value == "+":
                    result = result + right
                else:
                    result = result - right
            else:
                break
        return result

    # term = factor (('*' | '/' | '%') factor)*
    def _parse_term(self) -> float:
        result = self._parse_factor()
        while True:
            token = self._peek()
            if token is not None and token.type == "operator" and token.value in "*/%":
                self._consume()
                right = self._parse_factor()
                if token.value == "*":
                    result = result * right
                elif token.value == "/":
                    if right == 0:
                        raise _ExpressionError("除以零")
                    result = result / right
                else:
                    # JS remainder: the dividend's sign; by zero is NaN.
                    try:
                        result = math.fmod(result, right)
                    except (ValueError, TypeError):
                        result = float("nan")
            else:
                break
        return result

    # factor = ('+' | '-')? power
    def _parse_factor(self) -> float:
        token = self._peek()
        if token is not None and token.type == "operator" and token.value in "+-":
            self._consume()
            value = self._parse_power()
            return -value if token.value == "-" else value
        return self._parse_power()

    # power = atom ('^' | '**') power — right-associative
    # 注意：tokenizer 把 '**' 拆成两个 '*' token，需向前看一位区分乘法与幂
    def _parse_power(self) -> float:
        base = self._parse_atom()
        token = self._peek()
        if token is None or token.type != "operator":
            return base
        if token.value == "^":
            self._consume()
            exponent = self._parse_power()
            return _js_pow(base, exponent)
        if token.value == "*" and (
            second := self._peek_ahead()
        ) is not None and second.value == "*":
            self._consume()  # 第一个 *
            self._consume()  # 第二个 *
            exponent = self._parse_power()
            return _js_pow(base, exponent)
        return base

    # atom = number | constant | function '(' args ')' | '(' expression ')'
    def _parse_atom(self) -> float:
        token = self._peek()
        if token is None:
            raise _ExpressionError("意外的表达式结尾")

        if token.type == "number":
            self._consume()
            value = _parse_float(token.value)
            if math.isnan(value):
                raise _ExpressionError(f"无效数字: {token.value}")
            return value

        if token.type == "constant":
            self._consume()
            return MATH_CONSTANTS[token.value]

        if token.type == "function":
            self._consume()
            func_name = token.value
            nxt = self._peek()
            if nxt is None or nxt.type != "lparen":
                raise _ExpressionError(f"函数 {func_name} 后缺少括号")
            self._consume()  # consume '('

            args: list[float] = []
            first = self._peek()
            if first is not None and first.type != "rparen":
                args.append(self.parse())
                while True:
                    comma = self._peek()
                    if comma is None or comma.type != "comma":
                        break
                    self._consume()
                    args.append(self.parse())

            close_paren = self._peek()
            if close_paren is None or close_paren.type != "rparen":
                raise _ExpressionError("缺少右括号")
            self._consume()

            func = MATH_FUNCTIONS[func_name]
            try:
                return float(func(*args))
            except (TypeError, ValueError):
                # JS math functions answer domain/arity problems with NaN.
                return float("nan")

        if token.type == "lparen":
            self._consume()
            result = self.parse()
            close = self._peek()
            if close is None or close.type != "rparen":
                raise _ExpressionError("缺少右括号")
            self._consume()
            return result

        raise _ExpressionError(f"意外的 token: {token.type}({token.value})")


def _safe_evaluate(expr: str) -> float:
    prepared = expr.replace("^", "**").replace("π", "PI")
    prepared = re.sub(r"pi\b", "PI", prepared, flags=re.IGNORECASE)
    parser = _Parser(_tokenize(prepared))
    result = parser.parse()
    if math.isnan(result):
        raise _ExpressionError("计算结果不是有效数值")
    return result


#: The original expression inputs are short; this bound keeps a hostile
#: oversized payload from pinning the device on tokenizing work.
MAX_EXPRESSION_LENGTH = 4096


def evaluate_expression(expression: str) -> str:
    """Evaluate one plain-calculator expression, returning the result string.

    Mirrors the original tool: parse/evaluation problems come back as
    ``计算错误: …`` result strings (never exceptions), and a non-finite
    result is the original's 无穷大 hint.
    """
    if not isinstance(expression, str):
        raise TypeError("expression is required")
    if len(expression) > MAX_EXPRESSION_LENGTH:
        raise ValueError("expression too long")
    try:
        result = _safe_evaluate(expression.strip())
        if not math.isfinite(result):
            return "错误: 计算结果为无穷大或非数值，请检查输入参数"
        return _js_number_to_string(result)
    except _ExpressionError as err:
        return f"计算错误: {err}"


#: The seven aviation formulas the original shipped.
AERO_FORMULAS = (
    "lift",
    "drag",
    "reynolds",
    "mach",
    "dynamic_pressure",
    "lift_to_drag",
    "wing_loading",
)

#: The device capabilities the two fixed tools announce; one per original
#: tool, dispatched through the existing capability admission only.
CALCULATOR_OPERATIONS = frozenset({"local.calculator", "local.aero_calculator"})

_AIR_DENSITY = 1.225
_AIR_VISCOSITY = 1.789e-5
_SOUND_SPEED = 340.3


def _compute_aero(formula: Any, params: dict[str, Any]) -> str:
    """The original ``computeAero``: seven formulas, verbatim messages."""

    def shown(value: Any) -> str:
        return _js_number_to_string(float(value))

    if formula == "lift":
        # L = 0.5 * rho * V^2 * S * CL
        rho = params.get("rho", _AIR_DENSITY)
        if "V" not in params or "S" not in params or "CL" not in params:
            return (
                "缺少必要参数: 升力计算需要 V(速度,m/s), S(参考面积,m²), "
                "CL(升力系数)，可选 rho(空气密度,kg/m³，默认1.225)"
            )
        lift = 0.5 * rho * params["V"] * params["V"] * params["S"] * params["CL"]
        return (
            f"升力 L = 0.5 × {shown(rho)} × {shown(params['V'])}² × "
            f"{shown(params['S'])} × {shown(params['CL'])} = {_js_to_fixed(lift, 4)} N"
        )
    if formula == "drag":
        # D = 0.5 * rho * V^2 * S * CD
        rho = params.get("rho", _AIR_DENSITY)
        if "V" not in params or "S" not in params or "CD" not in params:
            return (
                "缺少必要参数: 阻力计算需要 V(速度,m/s), S(参考面积,m²), "
                "CD(阻力系数)，可选 rho(空气密度,kg/m³，默认1.225)"
            )
        drag = 0.5 * rho * params["V"] * params["V"] * params["S"] * params["CD"]
        return (
            f"阻力 D = 0.5 × {shown(rho)} × {shown(params['V'])}² × "
            f"{shown(params['S'])} × {shown(params['CD'])} = {_js_to_fixed(drag, 4)} N"
        )
    if formula == "reynolds":
        # Re = rho * V * L_char / mu
        rho = params.get("rho", _AIR_DENSITY)
        mu = params.get("mu", _AIR_VISCOSITY)
        if "V" not in params or "L_char" not in params:
            return (
                "缺少必要参数: 雷诺数计算需要 V(速度,m/s), L_char(特征长度,m)，"
                "可选 rho(空气密度,默认1.225), mu(动力粘度,默认1.789e-5 Pa·s)"
            )
        reynolds = rho * params["V"] * params["L_char"] / mu
        return (
            f"雷诺数 Re = {shown(rho)} × {shown(params['V'])} × "
            f"{shown(params['L_char'])} / {shown(mu)} = {_js_to_exponential(reynolds, 4)}"
        )
    if formula == "mach":
        # M = V / a
        sound = params.get("a", _SOUND_SPEED)
        if "V" not in params:
            return "缺少必要参数: 马赫数计算需要 V(速度,m/s)，可选 a(音速,m/s，默认340.3)"
        mach = params["V"] / sound
        return f"马赫数 M = {shown(params['V'])} / {shown(sound)} = {_js_to_fixed(mach, 6)}"
    if formula == "dynamic_pressure":
        # q = 0.5 * rho * V^2
        rho = params.get("rho", _AIR_DENSITY)
        if "V" not in params:
            return "缺少必要参数: 动压计算需要 V(速度,m/s)，可选 rho(空气密度,默认1.225)"
        pressure = 0.5 * rho * params["V"] * params["V"]
        return (
            f"动压 q = 0.5 × {shown(rho)} × {shown(params['V'])}² = "
            f"{_js_to_fixed(pressure, 4)} Pa"
        )
    if formula == "lift_to_drag":
        # L/D = CL / CD
        if "CL" not in params or "CD" not in params or params["CD"] == 0:
            return "缺少必要参数: 升阻比计算需要 CL(升力系数)和 CD(阻力系数)，且 CD 不能为0"
        ratio = params["CL"] / params["CD"]
        return f"升阻比 L/D = {shown(params['CL'])} / {shown(params['CD'])} = {_js_to_fixed(ratio, 4)}"
    if formula == "wing_loading":
        # W/S = W / S
        if "W" not in params or "S" not in params:
            return "缺少必要参数: 翼载荷计算需要 W(重量,N)和 S(参考面积,m²)"
        loading = params["W"] / params["S"]
        return f"翼载荷 W/S = {shown(params['W'])} / {shown(params['S'])} = {_js_to_fixed(loading, 4)} N/m²"
    return f"未知公式: {formula}。支持的公式: {', '.join(AERO_FORMULAS)}"


def evaluate_aero_arguments(arguments: dict[str, Any]) -> str:
    """Resolve one aviation-calculator payload to its result string.

    Accepts both shapes the original contract allowed: the structured
    ``formula``/``params`` fields, and the original raw JSON-string ``input``.
    Malformed JSON reports the original 解析错误 prefix (the engine-specific
    detail after it comes from the local JSON parser), missing fields the
    original 输入格式错误 line. ``params`` must be JSON numbers: the device
    refuses a non-numeric payload loudly instead of computing garbage.
    """
    if not isinstance(arguments, dict):
        raise TypeError("arguments must be a payload object")
    formula = arguments.get("formula")
    params = arguments.get("params")
    if formula is None and "input" in arguments:
        raw_input = arguments["input"]
        if not isinstance(raw_input, str):
            raise TypeError("input must be a string")
        try:
            parsed = json.loads(raw_input)
        except json.JSONDecodeError as err:
            return f"解析错误: 请提供有效的JSON输入。{err}"
        if not isinstance(parsed, dict):
            return "输入格式错误: 需要 formula 和 params 字段"
        formula = parsed.get("formula")
        params = parsed.get("params")
    if not formula or not isinstance(params, dict):
        return "输入格式错误: 需要 formula 和 params 字段"
    for value in params.values():
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("params must be numbers")
    return _compute_aero(formula, params)
