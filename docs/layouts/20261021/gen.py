"""成形機 5・6・9・10・11 台のレイアウト案を作り、平面図 PNG と一覧表を書き出す。

使い方: python3 gen.py （matplotlib が要る。出力はこのファイルと同じフォルダ）

寸法は依頼の値（成形機 1 台分の設備の帯、図 2・図 10）。依頼に無い間隔は README.md の「前提」の仮の値。
座標は mm。図面の左上が原点で、右が x、下が y。成形機はすべて横置き（長手が x）で、
案ごと 90 度回しても面積と長さは変わらない。
"""
from __future__ import annotations

import csv
import itertools
import math
import os
from dataclasses import dataclass, field

HERE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '外形なし')

# ---- 成形機と設備の帯（依頼の値。局所座標: u は型締側の端から射出側へ、v は中心軸から操作側を正）----
L = 11453            # 全長
OP = 1850            # 中心から操作側のカバー面（扉の線）
NOP = 2000           # 中心から反操作側のカバー面
BAND = 2020          # 扉の線から設備の帯の外側（プレスの端）
BEAM_OVER = 450      # 取出機の梁が帯の外側からさらに張り出す量（上空。解釈は README の前提）
BEAM_U = (5290, 5900)  # 梁の u の範囲（図 2 から読んだ値。落とし位置は u≈4,987）
DROP_U = 4987
UNIT_DEPTH = OP + NOP + BAND  # 5,870。1 台分の専有（成形機＋帯）の奥行

# 帯の中の装置（A の並び。u は型締側の端から、d は扉の線から外へ。図 2 から読んだ値）
PARTS_A = [
    ('粉砕機', (280, 1082), (922, 1717), '#c8ccd2'),
    ('カス回収', (1177, 2282), (819, 1813), '#f2c0bb'),
    ('ゲートカットプレス', (2282, 3881), (620, 2020), '#e8cf78'),
    ('搬入出台', (3881, 5687), (780, 1837), '#8a90a0'),
    ('トリミング', (5885, 6983), (1074, 1957), '#c9b6e4'),
    ('搬送ロボット', (6076, 6680), (223, 1630), '#e8a13a'),
    ('AGV 空トレー', (7293, 8383), (24, 915), '#efefef'),
    ('AGV 満杯', (7293, 8383), (1074, 1957), '#e4e4e4'),
]
AGV_ROWS = [(24, 915), (1074, 1957)]


def parts_for(t: str):
    """型 t（A〜D）の帯の装置を (名前, u 範囲, d 範囲, 色) で返す。B・D は落とし位置を軸に前後を裏返す"""
    out = []
    for name, (u0, u1), d, c in PARTS_A:
        if t in 'BD':
            u0, u1 = 2 * DROP_U - u1, 2 * DROP_U - u0
        out.append((name, (u0, u1), d, c))
    return out


def stand_u(t: str):
    """AGV の置き場の u 範囲"""
    return [p[1] for p in parts_for(t) if p[0].startswith('AGV')][0]


# ---- 依頼に無い間隔（仮の値。根拠は README）----
W_MACHINE = 1000     # 反操作側（帯の無い側）の人の通路
W_OP = 1500          # 操作側（帯の無い側）の通路。操作盤の前で人が作業する
W_BAND = 1500        # 帯の外側の通路（プレスの型交換・点検）
W_END = 1500         # AGV の無い端の通路（金型・保守）
AISLE = 2000         # AGV の通路の幅
END_MARGIN = 500     # 成形機の端と AGV の通路の間
TIGHT_NOSTAGGER = 2 * BEAM_OVER  # 帯どうしを詰めるとき、梁をずらさない場合の帯の間
BEAM_CLEAR = 200     # ずらした梁どうしの間


@dataclass
class Unit:
    t: str           # A〜D
    rot: int         # 0 か 180
    x0: float        # 回した後の外接の左端
    y0: float        # 回した後の外接の上端（帯を含む）
    band_down: bool
    no: int = 0

    # 局所 (u, v) → 図面 (x, y)。rot 0: x=u, y=v。rot 180: x=-u, y=-v。外接の左上を (x0, y0) に合わせる
    def vrange(self):
        return (-NOP, OP + BAND) if self.t in 'AB' else (-NOP - BAND, OP)

    def xy(self, u, v):
        v0, v1 = self.vrange()
        if self.rot == 0:
            return self.x0 + u, self.y0 + (v - v0)
        return self.x0 + (L - u), self.y0 + (v1 - v)

    def rect(self, u0, u1, v0, v1):
        xa, ya = self.xy(u0, v0)
        xb, yb = self.xy(u1, v1)
        return (min(xa, xb), min(ya, yb), max(xa, xb), max(ya, yb))

    def band_v(self, d0, d1):
        if self.t in 'AB':
            return OP + d0, OP + d1
        return -NOP - d1, -NOP - d0

    def machine(self):
        return self.rect(0, L, -NOP, OP)

    def footprint(self):
        v0, v1 = self.vrange()
        return self.rect(0, L, v0, v1)

    def parts(self):
        out = []
        for name, (u0, u1), (d0, d1), c in parts_for(self.t):
            va, vb = self.band_v(d0, d1)
            out.append((name, self.rect(u0, u1, va, vb), c))
        return out

    def beam(self):
        bu0, bu1 = BEAM_U if self.t in 'AC' else (2 * DROP_U - BEAM_U[1], 2 * DROP_U - BEAM_U[0])
        if self.t in 'AB':
            return self.rect(bu0, bu1, -NOP, OP + BAND + BEAM_OVER)
        return self.rect(bu0, bu1, -NOP - BAND - BEAM_OVER, OP)

    def stock_end(self):
        """AGV の出入りする端（'R' か 'L'）"""
        at_inj = self.t in 'AC'
        right = at_inj if self.rot == 0 else not at_inj
        return 'R' if right else 'L'

    def lanes(self):
        """AGV の 2 列の引込み（置き場の奥の端から機械の端まで）"""
        su0, su1 = stand_u(self.t)
        at_inj = self.t in 'AC'
        out = []
        for d0, d1 in AGV_ROWS:
            va, vb = self.band_v(d0, d1)
            u_from, u_to = (su0, L) if at_inj else (su1, 0)
            out.append(self.rect(min(u_from, u_to), max(u_from, u_to), va, vb))
        return out

    def op_band(self):
        return self.t in 'AB'


# 帯の向き × AGV の端 → (型, 回転)。typeset は 4 通りの組み合わせ方
TYPESETS = {
    'inj':   {('R', True): ('A', 0), ('R', False): ('C', 0), ('L', True): ('C', 180), ('L', False): ('A', 180)},
    'clamp': {('R', True): ('D', 180), ('R', False): ('B', 180), ('L', True): ('B', 0), ('L', False): ('D', 0)},
    'op':    {('R', True): ('A', 0), ('R', False): ('B', 180), ('L', True): ('B', 0), ('L', False): ('A', 180)},
    'nonop': {('R', True): ('D', 180), ('R', False): ('C', 0), ('L', True): ('C', 180), ('L', False): ('D', 0)},
}
TYPESET_JA = {
    'inj': 'A と C（射出側にストッカー、全台同じ向き）',
    'clamp': 'B と D（型締側にストッカー）',
    'op': 'A と B（操作側に帯）',
    'nonop': 'C と D（反操作側に帯、操作側が空く）',
}

# 積み方（列の中で、上から順の帯の向き。True = 帯が下）と、隣どうしの間
PATTERNS = {
    'P1': '同じ向きに積む',
    'P2': '帯を向かい合わせ（帯の外の通路を共用）',
    'P3s': '帯を向かい合わせて詰める（梁をずらして入れ違い）',
    'P3n': '帯を向かい合わせて詰める（梁はずらさない）',
    'P4': '背中合わせ（機械の側どうし）',
}


def band_seq(pattern: str, k: int):
    if pattern == 'P1':
        return [True] * k
    if pattern in ('P2', 'P3s', 'P3n'):
        return [i % 2 == 0 for i in range(k)]      # 下, 上, 下, 上 …（ペアの間で帯が向かい合う）
    if pattern == 'P4':
        return [i % 2 == 1 for i in range(k)]      # 上, 下, 上, 下 …（ペアの中で機械が背中合わせ）
    raise ValueError(pattern)


def face(t: str, band_down: bool, where: str):
    """台の上（top）か下（bottom）の面が、帯・操作側・反操作側のどれか"""
    band_side = 'bottom' if band_down else 'top'
    if where == band_side:
        return 'band'
    return 'nonop' if t in 'AB' else 'op'


def face_w(f):
    return {'band': W_BAND, 'op': W_OP, 'nonop': W_MACHINE}[f]


def gap(uf: str, lf: str, pattern: str):
    """上の台の下の面 uf と下の台の上の面 lf の間の通路の幅、と詰めたかどうか"""
    if uf == 'band' and lf == 'band':
        if pattern == 'P3s':
            return 0, 'tight'
        if pattern == 'P3n':
            return TIGHT_NOSTAGGER, 'tight'
    return max(face_w(uf), face_w(lf)), 'walk'


@dataclass
class Column:
    k: int
    end: str          # AGV の端
    x0: float = 0
    units: list = field(default_factory=list)
    walks: list = field(default_factory=list)   # 列の中を x 方向に走る人の通路（y0, y1）
    width: float = L
    height: float = 0
    tight_pairs: int = 0
    shift: float = 0


def build_column(k, end, pattern, typeset, x0):
    col = Column(k, end, x0)
    seq = band_seq(pattern, k)
    y = 0.0
    t0, _ = TYPESETS[typeset][(end, seq[0])]
    top = face_w(face(t0, seq[0], 'top'))      # 一番上の台の上の通路
    col.walks.append((y, y + top))
    y += top
    prev = None
    shift_total = 0.0
    for i, down in enumerate(seq):
        t, rot = TYPESETS[typeset][(end, down)]
        if prev is not None:
            g, kind = gap(face(prev.t, prev.band_down, 'bottom'), face(t, down, 'top'), pattern)
            if kind == 'walk':
                col.walks.append((y, y + g))
            else:
                col.tight_pairs += 1
            y += g
        u = Unit(t, rot, x0, y, down)
        # 詰めてずらす: 上の台の梁と重ならないよう、AGV の端と反対へずらす
        if prev is not None and pattern == 'P3s' and prev.band_down and not down and overlaps(
                grow_x(prev.beam(), BEAM_CLEAR), u.beam()):
            bx0, _, bx1, _ = prev.beam()
            cx0, _, cx1, _ = u.beam()
            if end == 'R':      # 左へずらす
                need = cx1 - (bx0 - BEAM_CLEAR)
                s = max(0.0, need)
                u.x0 -= s
                shift_total = max(shift_total, s)
            else:
                s = max(0.0, (bx1 + BEAM_CLEAR) - cx0)
                u.x0 += s
                shift_total = max(shift_total, s)
        col.units.append(u)
        y += UNIT_DEPTH
        prev = u
    bot = face_w(face(prev.t, prev.band_down, 'bottom'))
    col.walks.append((y, y + bot))
    y += bot
    col.height = y
    col.shift = shift_total
    col.width = L + shift_total
    # ずらした分、列の左端を揃え直す（AGV の端は機械の端で揃う）
    if end == 'R' and shift_total:
        for u in col.units:
            u.x0 += shift_total
    return col


def union_area(rects):
    xs = sorted({r[0] for r in rects} | {r[2] for r in rects})
    area = 0.0
    for a, b in zip(xs, xs[1:]):
        ivs = sorted((r[1], r[3]) for r in rects if r[0] <= a and r[2] >= b)
        cur0 = cur1 = None
        tot = 0.0
        for y0, y1 in ivs:
            if cur1 is None or y0 > cur1:
                if cur1 is not None:
                    tot += cur1 - cur0
                cur0, cur1 = y0, y1
            else:
                cur1 = max(cur1, y1)
        if cur1 is not None:
            tot += cur1 - cur0
        area += tot * (b - a)
    return area


def grow_x(r, d):
    return (r[0] - d, r[1], r[2] + d, r[3])


def overlaps(a, b, eps=1e-6):
    return a[0] < b[2] - eps and b[0] < a[2] - eps and a[1] < b[3] - eps and b[1] < a[3] - eps


@dataclass
class Layout:
    n: int
    structure: str
    pattern: str
    typeset: str
    join: str
    cols: list
    aisles: list          # (x0, y0, x1, y1, 向き)
    walks_v: list         # 列の間・外の縦の人の通路
    width: float
    height: float
    exits: list           # (x, y, 向き)
    trunk_len: float
    lane_len: float
    crossings: int
    occupied: float
    title: str = ''
    no: int = 0
    warn: list = field(default_factory=list)

    @property
    def units(self):
        return [u for c in self.cols for u in c.units]


def build(n, structure, colspec, pattern, typeset, join):
    """colspec: [(台数, AGV の端)] を左から。列の間は端の組み合わせで決める"""
    x = 0.0
    cols, aisles, walks_v, segs = [], [], [], []
    # 左の外側
    first_end = colspec[0][1]
    if first_end == 'L':
        aisles.append([x, AISLE]); x += AISLE + END_MARGIN
    else:
        walks_v.append([x, W_END]); x += W_END
    for i, (k, end) in enumerate(colspec):
        col = build_column(k, end, pattern, typeset, x)
        cols.append(col)
        x += col.width
        nxt = colspec[i + 1][1] if i + 1 < len(colspec) else None
        if nxt is None:
            if end == 'R':
                x += END_MARGIN; aisles.append([x, AISLE]); x += AISLE
            else:
                walks_v.append([x, W_END]); x += W_END
        else:
            if end == 'R' and nxt == 'L':
                x += END_MARGIN; aisles.append([x, AISLE]); x += AISLE + END_MARGIN
            elif end == 'L' and nxt == 'R':
                walks_v.append([x, W_END]); x += W_END
            elif end == 'R' and nxt == 'R':
                x += END_MARGIN; aisles.append([x, AISLE]); x += AISLE
                walks_v.append([x, W_END]); x += W_END
            else:  # L, L
                walks_v.append([x, W_END]); x += W_END
                aisles.append([x, AISLE]); x += AISLE + END_MARGIN
    width = x
    H = max(c.height for c in cols)
    height = H
    # 通路の高さ: 隣の列の高い方
    def adj_cols(ax0, aw):
        return [c for c in cols if abs(c.x0 - (ax0 + aw)) < END_MARGIN + 1 or abs(c.x0 + c.width - ax0) < END_MARGIN + 1]
    aisle_rects = []
    trunk = 0.0
    exits = []
    multi = len(aisles) > 1
    if multi and join == 'joined':
        height = H + END_MARGIN + AISLE
    for ax0, aw in aisles:
        ac = adj_cols(ax0, aw)
        top_lane = min(min(l[1] for u in c.units for l in u.lanes()) for c in ac)
        yb = height
        aisle_rects.append((ax0, 0, ax0 + aw, yb))
        trunk += yb - top_lane - (AISLE / 2 if multi and join == 'joined' else 0)
        if not (multi and join == 'joined'):
            exits.append((ax0 + aw / 2, yb, 'down'))
    if multi and join == 'joined':
        cx0 = aisles[0][0]
        cy0 = H + END_MARGIN
        aisle_rects.append((cx0, cy0, width, cy0 + AISLE))
        trunk += width - (aisles[0][0] + AISLE / 2)
        exits.append((width, cy0 + AISLE / 2, 'right'))
    # 引込み: 置き場の奥から通路の中心線まで
    lane_len = 0.0
    for c in cols:
        for u in c.units:
            for r in u.lanes():
                if u.stock_end() == 'R':
                    ac = [a for a in aisles if a[0] >= r[2] - 1][0]
                    lane_len += ac[0] + ac[1] / 2 - r[0]
                else:
                    ac = [a for a in aisles if a[0] + a[1] <= r[0] + 1][-1]
                    lane_len += r[2] - (ac[0] + ac[1] / 2)
    # 人の通路（列の中の横の通路）が AGV の通路を横切る数
    crossings = sum(len(c.walks) for c in cols)
    # 占有: 列（通路込み）＋列の間の通路＋AGV の通路
    rects = []
    for c in cols:
        rects.append((c.x0 - (END_MARGIN if c.end == 'L' else 0), 0, c.x0 + c.width + (END_MARGIN if c.end == 'R' else 0), c.height))
    for wx, ww in walks_v:
        hs = [c.height for c in cols if abs(c.x0 - (wx + ww)) < 1 or abs(c.x0 + c.width - wx) < 1]
        rects.append((wx, 0, wx + ww, max(hs) if hs else H))
    for ax0, aw in aisles:
        ac = adj_cols(ax0, aw)
        rects.append((ax0, 0, ax0 + aw, height if (multi and join == 'joined') else max(c.height for c in ac)))
    if multi and join == 'joined':
        rects.append(aisle_rects[-1])
        # 縦の通路を横の幹線まで
        for ax0, aw in aisles:
            rects.append((ax0, 0, ax0 + aw, height))
    occupied = union_area(rects)
    lay = Layout(n, structure, pattern, typeset, join, cols, aisle_rects, walks_v, width, height, exits,
                 trunk, lane_len, crossings, occupied)
    lay.warn = check(lay)
    return lay


def check(lay: Layout):
    """床の上の物（機械・帯の装置）どうし、床の物と AGV の通路・引込み、梁どうしの重なりを調べる"""
    bad = []
    us = lay.units
    floor = []
    for i, u in enumerate(us):
        floor.append((i, 'machine', u.machine()))
        for name, r, _ in u.parts():
            floor.append((i, name, r))
    for (i, a, ra), (j, b, rb) in itertools.combinations(floor, 2):
        if i != j and overlaps(ra, rb):
            bad.append(f'{i + 1} {a} と {j + 1} {b} が重なる')
    for i, u in enumerate(us):
        for lane in u.lanes():
            for (j, b, rb) in floor:
                if j == i and b.startswith('AGV'):
                    continue
                if j == i and b == 'machine':
                    continue
                if overlaps(lane, rb) and not (j == i):
                    bad.append(f'{i + 1} の AGV の引込みに {j + 1} {b} が入る')
                elif j == i and overlaps(lane, rb):
                    bad.append(f'{i + 1} の AGV の引込みに自分の {b} が入る')
        for a in lay.aisles:
            for (j, b, rb) in floor:
                if overlaps(a[:4], rb):
                    bad.append(f'AGV の通路に {j + 1} {b} が入る')
    for (i, u), (j, w) in itertools.combinations(enumerate(us), 2):
        if overlaps(u.beam(), w.beam()):
            bad.append(f'{i + 1} と {j + 1} の取出機の梁が重なる')
    return sorted(set(bad))


def structures(n):
    h = math.ceil(n / 2)
    out = [
        ('1 列', [(n, 'R')]),
        ('2 列・AGV の通路を共用', [(h, 'R'), (n - h, 'L')]),
        ('2 列・AGV の通路を外側に 2 本', [(h, 'L'), (n - h, 'R')]),
        ('2 列・同じ向き', [(h, 'R'), (n - h, 'R')]),
    ]
    if n >= 5:
        a = math.ceil(n / 3); b = math.ceil((n - a) / 2); c = n - a - b
        out.append(('3 列（2 列は通路を共用）', [(a, 'R'), (b, 'L'), (c, 'R')]))
    if n >= 9:
        q = [n // 4 + (1 if i < n % 4 else 0) for i in range(4)]
        out.append(('4 列（2 列ずつ通路を共用）', [(q[0], 'R'), (q[1], 'L'), (q[2], 'R'), (q[3], 'L')]))
    if n % 2 == 1 and n >= 9:
        out.append(('2 列・AGV の通路を共用（片寄せ）', [(h + 1, 'R'), (n - h - 1, 'L')]))
    return out


TSUBO = 3.305785


def all_layouts(n):
    res = []
    for sname, spec in structures(n):
        joins = ['each', 'joined'] if len(build(n, sname, spec, 'P1', 'inj', 'each').aisles) > 1 else ['each']
        for p in PATTERNS:
            if p in ('P2', 'P3s', 'P3n', 'P4') and max(k for k, _ in spec) < 2:
                continue
            for ts in TYPESETS:
                for j in joins:
                    lay = build(n, sname, spec, p, ts, j)
                    res.append(lay)
    return res


def area_m2(lay):
    return lay.width * lay.height / 1e6


def pick(n, lays):
    """台数ごとに出す案を選ぶ。
    1. 重なりの無い案だけ。梁をずらさなくても入れ違う型の組み合わせでは「詰め（ずらさない）」は劣るだけなので外す
    2. 列の組み方 × 積み方 × 出口のまとめ方ごとに、型の組み合わせのいちばん良いもの 1 案（同じ面積なら C と D を先に）
    3. 面積の小さい方から 14 案。どの列の組み方も、いちばん良い 1 案は必ず入れる。同じ向き・背中合わせの最良も参考に入れる
    4. 小さい方から 3 つの組み方は、型の組み合わせ違いもすべて並べる"""
    ok = [l for l in lays if not l.warn]
    no_shift = {(l.structure, l.typeset, l.join) for l in ok if l.pattern == 'P3s' and max(c.shift for c in l.cols) == 0}
    ok = [l for l in ok if not (l.pattern == 'P3n' and (l.structure, l.typeset, l.join) in no_shift)]
    pref = {'nonop': 0, 'inj': 1, 'clamp': 2, 'op': 3}
    key = lambda l: (round(area_m2(l), 1), round(l.occupied / 1e6, 1), pref[l.typeset], l.lane_len)
    by = {}
    for l in ok:
        by.setdefault((l.structure, l.pattern, l.join), []).append(l)
    reps = sorted((sorted(v, key=key)[0] for v in by.values()), key=key)
    out = reps[:14]
    for cond in [lambda l, s=s: l.structure == s for s in {l.structure for l in reps}] + \
            [lambda l: l.pattern == 'P1', lambda l: l.pattern == 'P4']:
        best = next(l for l in reps if cond(l))
        if best not in out:
            out.append(best)
    for top in reps[:3]:
        for l in sorted(by[(top.structure, top.pattern, top.join)], key=key):
            if l not in out:
                out.append(l)
    out.sort(key=key)
    return out


def concerns(l: Layout):
    c = []
    ts = l.typeset
    nop = sum(1 for u in l.units if u.op_band())
    if nop == len(l.units):
        c.append('全台、操作側に帯がある。操作盤と操作側の扉の前を帯（A はトリミング・AGV の 2 列、B はプレス）がふさぎ、操作盤へは帯の切れ目か端から回り込む')
    elif nop:
        c.append(f'{nop} 台は操作側に帯がある（操作盤と操作側の扉の前を帯がふさぐ）。残りは操作側が通路に面して空く')
    else:
        c.append('全台、操作側が人の通路に面して空く（操作盤・扉に直接行ける）。代わりに反操作側の扉・点検口の前を帯がふさぐ')
    ends = {u.t in 'AC' for u in l.units}
    if ends == {True}:
        c.append('AGV の通路が射出側の端を通る。スクリューの抜き取りや射出ユニットの点検の場所と AGV が重なるので、そのときは通路を止める')
    elif ends == {False}:
        c.append('AGV の通路が型締側の端を通り、射出側の端は人の通路に面する（スクリューの点検がしやすい）')
    else:
        c.append('射出側から出入りする台と型締側から出入りする台が混ざる')
    tight = sum(col.tight_pairs for col in l.cols)
    if l.pattern == 'P3s' and max(col.shift for col in l.cols) == 0:
        c.append(f'向かい合う帯の間に通路が無い（{tight} 組）。プレスの型交換・点検は帯の端から。この型の組み合わせでは取出機の梁が初めから前後に入れ違うので、ずらさずに詰められる')
    elif l.pattern == 'P3s':
        sh = max(col.shift for col in l.cols)
        c.append(f'向かい合う帯の間に通路が無い（{tight} 組）。プレスの型交換・点検は帯の端から。取出機の梁を {sh:,.0f} mm ずらして上空で入れ違わせるため、列の幅がその分広い')
    elif l.pattern == 'P3n':
        c.append(f'向かい合う帯の間は {TIGHT_NOSTAGGER:,} mm（梁の張り出しどうしが当たらない幅）で、人がやっと通れる程度。プレスの型交換は帯の端から')
    if len(l.aisles) - (1 if l.join == 'joined' and len([a for a in l.aisles]) > 1 else 0) >= 1:
        pass
    shared = any(a for a in structures_shared(l))
    if shared:
        c.append('両側の列の AGV が 1 本の通路に出入りする。台数が多いと通路の中で待ちが出やすい')
    c.append(f'人の横の通路が AGV の通路を {l.crossings} か所で横切る')
    if len(l.exits) == 1:
        c.append('梱包場所への出口は 1 か所（' + ('下の横の幹線の右端' if l.exits[0][2] == 'right' else '通路の下の端') + '）')
    else:
        c.append(f'出口が {len(l.exits)} か所に分かれる。梱包場所までは外でつなぐ通路が別に要る')
    r = max(l.width, l.height) / min(l.width, l.height)
    if r >= 3:
        c.append(f'細長い（縦横比 {r:.1f}）。建物に入るかを先に確かめる')
    hs = [col.height for col in l.cols]
    if max(hs) - min(hs) > 1:
        c.append('列の長さがそろわず、短い列の先が空く（その分は外接に入るが占有には入らない）')
    return c


def structures_shared(l):
    return [1 for i in range(len(l.cols) - 1) if l.cols[i].end == 'R' and l.cols[i + 1].end == 'L']


# ---- 描画 ----
def draw(l: Layout, path):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from matplotlib import font_manager
    from matplotlib.patches import Rectangle, FancyArrow
    fp = '/usr/share/fonts/opentype/ipafont-gothic/ipagp.ttf'
    if os.path.exists(fp):
        font_manager.fontManager.addfont(fp)
        plt.rcParams['font.family'] = font_manager.FontProperties(fname=fp).get_name()
    W, H = l.width, l.height
    scale = 1 / 1000
    fig_w = 13
    fig_h = max(5.5, min(22, fig_w * H / W * 0.9 + 2.2))
    fig, ax = plt.subplots(figsize=(fig_w, fig_h), dpi=110)
    ax.set_aspect('equal')
    ax.add_patch(Rectangle((0, 0), W * scale, H * scale, fill=False, ec='#333', lw=1.2, ls='--'))
    for c in l.cols:
        for y0, y1 in c.walks:
            ax.add_patch(Rectangle((c.x0 * scale, y0 * scale), c.width * scale, (y1 - y0) * scale, fc='#fbf6e8', ec='none'))
    for wx, ww in l.walks_v:
        hs = [c.height for c in l.cols if abs(c.x0 - (wx + ww)) < 1 or abs(c.x0 + c.width - wx) < 1]
        ax.add_patch(Rectangle((wx * scale, 0), ww * scale, (max(hs) if hs else H) * scale, fc='#fbf6e8', ec='none'))
    for ax0, ay0, ax1, ay1 in l.aisles:
        ax.add_patch(Rectangle((ax0 * scale, ay0 * scale), (ax1 - ax0) * scale, (ay1 - ay0) * scale, fc='#dcefdc', ec='#3a8a3a', lw=0.8))
    for i, u in enumerate(l.units):
        m = u.machine()
        ax.add_patch(Rectangle((m[0] * scale, m[1] * scale), (m[2] - m[0]) * scale, (m[3] - m[1]) * scale, fc='#dfe2e6', ec='#777', lw=0.8))
        # 型締側の印（濃い帯）
        cl = u.rect(0, 5154, -NOP, OP)
        ax.add_patch(Rectangle((cl[0] * scale, cl[1] * scale), (cl[2] - cl[0]) * scale, (cl[3] - cl[1]) * scale, fc='#cfd3d9', ec='none'))
        inj = u.rect(7850, L, -NOP + 843, OP - 557)
        ax.add_patch(Rectangle((inj[0] * scale, inj[1] * scale), (inj[2] - inj[0]) * scale, (inj[3] - inj[1]) * scale, fc='#c3c8cf', ec='#999', lw=0.4))
        for lane in u.lanes():
            if u.stock_end() == 'R':
                a = min((a for a in l.aisles if a[0] >= lane[2] - 1 and a[3] - a[1] > 0 and a[2] - a[0] <= AISLE + 1), key=lambda a: a[0])
                lane = (lane[0], lane[1], (a[0] + a[2]) / 2, lane[3])
            else:
                a = max((a for a in l.aisles if a[2] <= lane[0] + 1 and a[2] - a[0] <= AISLE + 1), key=lambda a: a[0])
                lane = ((a[0] + a[2]) / 2, lane[1], lane[2], lane[3])
            ax.add_patch(Rectangle((lane[0] * scale, lane[1] * scale), (lane[2] - lane[0]) * scale, (lane[3] - lane[1]) * scale, fc='none', ec='#3a8a3a', lw=0.6, ls='--'))
        for name, r, colr in u.parts():
            ax.add_patch(Rectangle((r[0] * scale, r[1] * scale), (r[2] - r[0]) * scale, (r[3] - r[1]) * scale, fc=colr, ec='#555', lw=0.5))
        b = u.beam()
        ax.add_patch(Rectangle((b[0] * scale, b[1] * scale), (b[2] - b[0]) * scale, (b[3] - b[1]) * scale, fc='none', ec='#2a5fc4', lw=0.8, ls='-.'))
        mx, my = (m[0] + m[2]) / 2, (m[1] + m[3]) / 2
        # 操作側の印
        ov = u.rect(0, L, OP - 60, OP)
        ax.add_patch(Rectangle((ov[0] * scale, ov[1] * scale), (ov[2] - ov[0]) * scale, (ov[3] - ov[1]) * scale, fc='#d33', ec='none'))
        side = '型締' if True else ''
        cx, _ = u.xy(1200, 0)
        ix, _ = u.xy(L - 1200, 0)
        ax.text(mx * scale, my * scale, f'{i + 1} {u.t}', ha='center', va='center', fontsize=10, weight='bold')
        ax.text(cx * scale, my * scale, '型締', ha='center', va='center', fontsize=6, color='#555')
        ax.text(ix * scale, my * scale, '射出', ha='center', va='center', fontsize=6, color='#555')
    for x, y, d in l.exits:
        if d == 'down':
            ax.add_patch(FancyArrow(x * scale, (y - 1500) * scale, 0, 2.6, width=0.5, head_width=1.4, head_length=1.0, color='#2d7a2d'))
            ax.text(x * scale, (y + 2700) * scale, '出口', ha='center', va='top', fontsize=8, color='#2d7a2d')
        else:
            ax.add_patch(FancyArrow((x - 1500) * scale, y * scale, 2.6, 0, width=0.5, head_width=1.4, head_length=1.0, color='#2d7a2d'))
            ax.text((x + 2700) * scale, y * scale, '出口', ha='left', va='center', fontsize=8, color='#2d7a2d')
    ax.set_xlim(-1.5, W * scale + (5 if any(e[2] == 'right' for e in l.exits) else 1.5))
    ax.set_ylim(H * scale + 5, -2)
    ax.set_xticks(range(0, int(W * scale) + 1, 5))
    ax.set_yticks(range(0, int(H * scale) + 1, 5))
    ax.tick_params(labelsize=7)
    ax.grid(color='#eee', lw=0.5)
    ax.set_xlabel('m', fontsize=8)
    a = area_m2(l)
    ax.set_title(f'{l.title}\n外接 {W / 1000:.1f} × {H / 1000:.1f} m ＝ {a:,.0f} m²（{a / TSUBO:,.0f} 坪）、1 台あたり {a / TSUBO / l.n:.1f} 坪　'
                 f'占有 {l.occupied / 1e6:,.0f} m²　AGV の幹線 {l.trunk_len / 1000:.0f} m・引込み {l.lane_len / 1000:.0f} m・出口 {len(l.exits)}',
                 fontsize=9.5, loc='left')
    leg = '灰: 成形機（数字は台の番号と型、赤い線が操作側）　色の箱: 帯の装置　青の一点鎖線: 取出機の梁（上空）　緑: AGV の通路と引込み（破線）　薄い黄: 人の通路'
    fig.text(0.01, 0.005, leg, fontsize=7, color='#444')
    fig.tight_layout(rect=(0, 0.02, 1, 1))
    fig.savefig(path, dpi=110)
    plt.close(fig)
    from PIL import Image
    Image.open(path).convert('RGB').quantize(colors=64, method=Image.Quantize.MEDIANCUT).save(path, optimize=True)


def main():
    rows = []
    md = []
    for n in (5, 6, 9, 10, 11):
        lays = pick(n, all_layouts(n))
        for k, l in enumerate(lays, 1):
            l.no = k
            l.title = f'{n} 台 案 {k}: {l.structure}、{PATTERNS[l.pattern]}、{TYPESET_JA[l.typeset]}' + ('、出口を 1 つにまとめる' if l.join == 'joined' else '')
            draw(l, os.path.join(HERE, f'{n}台_案{k}.png'))
            a = area_m2(l)
            own = n * L * UNIT_DEPTH / 1e6
            rows.append({
                '台数': n, '案': k, '列の組み方': l.structure, '積み方': PATTERNS[l.pattern], '型': TYPESET_JA[l.typeset],
                '出口のまとめ': 'まとめる' if l.join == 'joined' else '通路ごと',
                '外接 幅 m': round(l.width / 1000, 1), '外接 奥行 m': round(l.height / 1000, 1),
                '外接 m2': round(a, 1), '外接 坪': round(a / TSUBO, 1),
                '1台あたり 坪': round(a / TSUBO / n, 2), '共用部 坪': round((a - own) / TSUBO, 1),
                '占有 m2': round(l.occupied / 1e6, 1), '占有 坪': round(l.occupied / 1e6 / TSUBO, 1),
                'AGV 幹線 m': round(l.trunk_len / 1000, 1), 'AGV 引込み m': round(l.lane_len / 1000, 1),
                '出口の数': len(l.exits), '人とAGVの交差': l.crossings,
                '操作側に帯の台数': sum(1 for u in l.units if u.op_band()),
                '型の並び': ''.join(u.t for u in l.units),
                '気になる点': ' / '.join(concerns(l)),
            })
        print(n, len(lays), [round(area_m2(l)) for l in lays])
    with open(os.path.join(HERE, '一覧.csv'), 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    return rows


if __name__ == '__main__':
    main()
