"""Minimal STEP (ISO-10303-21) argument parser for IFC files.

Only what this project needs: parse one entity line into (id, TYPE, args),
where args is a nested list of: int refs ('#12' -> Ref(12)), str, float, int,
enums ('.T.' -> Enum('T')), None ($), '*' (Derived), typed values
(IFCTEXT('x') -> Typed('IFCTEXT', ['x'])).
"""
import re, zipfile


def open_ifc(path):
    """Open an .ifc file, or the first .ifc inside a .zip, as a binary line stream."""
    if path.lower().endswith(".zip"):
        z = zipfile.ZipFile(path)
        names = [n for n in z.namelist() if n.lower().endswith(".ifc")]
        if not names:
            raise SystemExit(f"No .ifc file inside {path}")
        return z.open(names[0])
    return open(path, "rb")


class Ref(int):
    __slots__ = ()
    def __repr__(self):
        return f"#{int(self)}"


class Enum(str):
    __slots__ = ()


class Typed:
    __slots__ = ("type", "args")
    def __init__(self, t, a):
        self.type = t
        self.args = a
    def __repr__(self):
        return f"{self.type}({self.args})"
    @property
    def value(self):
        return self.args[0] if self.args else None


DERIVED = object()

_x2 = re.compile(r"\\X2\\([0-9A-Fa-f]+)\\X0\\")
_x1 = re.compile(r"\\X\\([0-9A-Fa-f]{2})")
_s = re.compile(r"\\S\\(.)")


def decode_str(s):
    if "\\" not in s:
        return s
    def x2(m):
        h = m.group(1)
        return "".join(chr(int(h[i:i + 4], 16)) for i in range(0, len(h), 4))
    s = _x2.sub(x2, s)
    s = _x1.sub(lambda m: chr(int(m.group(1), 16)), s)
    s = _s.sub(lambda m: chr(ord(m.group(1)) + 128), s)
    return s.replace("\\\\", "\\")


def parse_args(s, i=0):
    """Parse a parenthesised list starting at s[i]=='('. Returns (list, next_index)."""
    assert s[i] == "("
    i += 1
    out = []
    n = len(s)
    while i < n:
        c = s[i]
        if c == ")":
            return out, i + 1
        if c == "," or c == " ":
            i += 1
            continue
        if c == "(":
            v, i = parse_args(s, i)
            out.append(v)
        elif c == "'":
            j = i + 1
            buf = []
            while True:
                k = s.index("'", j)
                buf.append(s[j:k])
                if k + 1 < n and s[k + 1] == "'":
                    buf.append("'")
                    j = k + 2
                else:
                    i = k + 1
                    break
            out.append(decode_str("".join(buf)))
        elif c == "#":
            j = i + 1
            while j < n and s[j].isdigit():
                j += 1
            out.append(Ref(int(s[i + 1:j])))
            i = j
        elif c == "$":
            out.append(None)
            i += 1
        elif c == "*":
            out.append(DERIVED)
            i += 1
        elif c == ".":
            j = s.index(".", i + 1)
            out.append(Enum(s[i + 1:j]))
            i = j + 1
        elif c.isalpha():
            j = i
            while s[j] != "(":
                j += 1
            name = s[i:j]
            v, i = parse_args(s, j)
            out.append(Typed(name, v))
        else:
            j = i
            while j < n and s[j] not in ",)":
                j += 1
            tok = s[i:j]
            try:
                out.append(int(tok))
            except ValueError:
                out.append(float(tok))
            i = j
    raise ValueError("unterminated list")


def parse_line(line):
    """'#12=IFCFOO(a,b);' -> (12, 'IFCFOO', [a,b])"""
    eq = line.index("=")
    eid = int(line[1:eq])
    p = line.index("(", eq)
    t = line[eq + 1:p].strip()
    args, _ = parse_args(line, p)
    return eid, t, args
