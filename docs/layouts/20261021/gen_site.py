"""成形機 5・6・9・10・11 台を、工場1・工場2 を合わせた L 字の敷地に収める案を作る。

使い方: python3 gen_site.py [背景画像 出力フォルダ]
  引数なし: このフォルダに外形線だけの平面図 PNG と 一覧.csv を書く
  引数あり: 背景画像（室内の図面）を敷いた平面図を、出力フォルダに書く（リポには入れない）

部品（成形機 1 台分の帯 A〜D）と間隔の前提は gen.py と同じ。敷地は外形線だけを持つ。
座標は mm。敷地の左上（工場2 の北西の角の延長と工場1 の北壁の交点）が原点。
"""
from __future__ import annotations

import csv
import itertools
import math
import os
import sys
from collections import deque

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gen  # noqa: E402
from gen import L, AISLE, END_MARGIN, W_END, UNIT_DEPTH, TSUBO, PATTERNS, TYPESETS, TYPESET_JA  # noqa: E402

# ---- 敷地（外形線だけ）----
# 工場2（西）15.5 × 39.3 m、工場1（東）20.0 × 45.7 m。中央の仕切りは無視して 1 つの床として扱う
SITE_W, SITE_H = 35500, 45700
NOTCH_X, NOTCH_Y = 15500, 6400        # 工場2 は北が 6.4 m 短い（x < 15.5 m では y ≥ 6.4 m）
SITE_POLY = [(0, NOTCH_Y), (NOTCH_X, NOTCH_Y), (NOTCH_X, 0), (SITE_W, 0), (SITE_W, SITE_H), (0, SITE_H)]
SITE_AREA = SITE_W * SITE_H - NOTCH_X * NOTCH_Y
SHUTTER = (38800, 43000)              # 東の壁の電動シャッター（y の範囲）。梱包場所への出口
AGV_CLEAR = 200                       # AGV の通路の端と機械・装置の間の余裕（シャッターまでの道を探すとき）
GRID = 200                            # 道を探す升目


def inside(r, eps=1e-6):
    x0, y0, x1, y1 = r
    if x0 < -eps or y0 < -eps or x1 > SITE_W + eps or y1 > SITE_H + eps:
        return False
    return y0 >= NOTCH_Y - eps or x0 >= NOTCH_X - eps


# ---- 案を組む（局所の座標。成形機は横置き、列は縦に積む）----
def assemble(n, spec, pattern, typeset, offs):
    """spec: [(台数, AGV の端)]、offs: 列ごとの y のずらし。gen.build と同じ組み方で、列ごとに上下にずらせる"""
    x = 0.0
    cols, aisles, walks_v = [], [], []
    if spec[0][1] == 'L':
        aisles.append([x, AISLE]); x += AISLE + END_MARGIN
    else:
        walks_v.append([x, W_END]); x += W_END
    for i, (k, end) in enumerate(spec):
        col = gen.build_column(k, end, pattern, typeset, x)
        dy = offs[i]
        for u in col.units:
            u.y0 += dy
        col.walks = [(a + dy, b + dy) for a, b in col.walks]
        col.dy = dy
        cols.append(col)
        x += col.width
        nxt = spec[i + 1][1] if i + 1 < len(spec) else None
        if nxt is None:
            if end == 'R':
                x += END_MARGIN; aisles.append([x, AISLE]); x += AISLE
            else:
                walks_v.append([x, W_END]); x += W_END
        elif end == 'R' and nxt == 'L':
            x += END_MARGIN; aisles.append([x, AISLE]); x += AISLE + END_MARGIN
        elif end == 'L' and nxt == 'R':
            walks_v.append([x, W_END]); x += W_END
        elif end == 'R' and nxt == 'R':
            x += END_MARGIN; aisles.append([x, AISLE]); x += AISLE
            walks_v.append([x, W_END]); x += W_END
        else:
            walks_v.append([x, W_END]); x += W_END
            aisles.append([x, AISLE]); x += AISLE + END_MARGIN

    def adj(x0, w):
        return [c for c in cols if abs(c.x0 - (x0 + w)) < END_MARGIN + 1 or abs(c.x0 + c.width - x0) < END_MARGIN + 1]

    def span(cs):
        return min(c.dy for c in cs), max(c.dy + c.height for c in cs)

    el = []   # (種類, 四角, 付け足し)
    for c in cols:
        for a, b in c.walks:
            el.append(('walk', (c.x0, a, c.x0 + c.width, b), None))
        el.append(('col', (c.x0 - (END_MARGIN if c.end == 'L' else 0), c.dy,
                           c.x0 + c.width + (END_MARGIN if c.end == 'R' else 0), c.dy + c.height), None))
    for wx, ww in walks_v:
        y0, y1 = span(adj(wx, ww))
        el.append(('walk', (wx, y0, wx + ww, y1), None))
    aisle_rects = []
    for ax0, aw in aisles:
        y0, y1 = span(adj(ax0, aw))
        r = (ax0, y0, ax0 + aw, y1)
        aisle_rects.append(r)
        el.append(('aisle', r, None))
    units = [u for c in cols for u in c.units]
    for i, u in enumerate(units):
        el.append(('machine', u.machine(), i))
        el.append(('clamp', u.rect(0, 5154, -gen.NOP, gen.OP), None))
        el.append(('inj', u.rect(7850, L, -gen.NOP + 843, gen.OP - 557), None))
        el.append(('opline', u.rect(0, L, gen.OP - 60, gen.OP), None))
        for lane in u.lanes():
            if u.stock_end() == 'R':
                a = min((a for a in aisle_rects if a[0] >= lane[2] - 1), key=lambda a: a[0])
                lane = (lane[0], lane[1], (a[0] + a[2]) / 2, lane[3])
            else:
                a = max((a for a in aisle_rects if a[2] <= lane[0] + 1), key=lambda a: a[0])
                lane = ((a[0] + a[2]) / 2, lane[1], lane[2], lane[3])
            el.append(('lane', lane, None))
        for name, r, colr in u.parts():
            el.append(('part', r, (colr, i)))
        el.append(('beam', u.beam(), None))
        mx, my = (u.machine()[0] + u.machine()[2]) / 2, (u.machine()[1] + u.machine()[3]) / 2
        el.append(('label', (mx, my, mx, my), f'{i + 1} {u.t}'))
        cx, _ = u.xy(1200, 0)
        ix, _ = u.xy(L - 1200, 0)
        el.append(('small', (cx, my, cx, my), '型締'))
        el.append(('small', (ix, my, ix, my), '射出'))
    meta = dict(cols=cols, units=units, crossings=sum(len(c.walks) for c in cols))
    return el, meta


def transform(el, rot, tx=0.0, ty=0.0):
    """90 度ずつ時計回りに回して（y は下向き）、外接の左上を (tx, ty) に置く"""
    def p(x, y):
        for _ in range(rot):
            x, y = -y, x
        return x, y
    out = []
    for k, r, extra in el:
        a = p(r[0], r[1]); b = p(r[2], r[3])
        out.append([k, (min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1])), extra])
    xs = [e[1][0] for e in out if e[0] not in ('label', 'small')]
    ys = [e[1][1] for e in out if e[0] not in ('label', 'small')]
    dx, dy = tx - min(xs), ty - min(ys)
    for e in out:
        r = e[1]
        e[1] = (r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy)
    return out


def bbox(el):
    rs = [e[1] for e in el if e[0] not in ('label', 'small')]
    return (min(r[0] for r in rs), min(r[1] for r in rs), max(r[2] for r in rs), max(r[3] for r in rs))


FIT_KINDS = ('col', 'walk', 'aisle', 'machine', 'part', 'beam', 'lane')


def fits(el):
    return all(inside(e[1]) for e in el if e[0] in FIT_KINDS)


# ---- シャッターまでの道 ----
def route(el):
    """AGV の通路（列の通路）それぞれから東のシャッターまでの、幅 2 m の道を升目で探す。
    返り値: (道の四角のリスト, 道の長さ mm) か、つながらなければ None"""
    nx, ny = SITE_W // GRID, SITE_H // GRID
    cx = (np.arange(nx) + 0.5) * GRID
    cy = (np.arange(ny) + 0.5) * GRID
    X, Y = np.meshgrid(cx, cy)            # [y, x]
    h = AISLE / 2
    ok = (X >= h) & (X <= SITE_W - h) & (Y <= SITE_H - h) & ((Y >= NOTCH_Y + h) | ((X >= NOTCH_X + h) & (Y >= h)))
    for k, r, _ in el:
        if k in ('machine', 'part'):
            d = h + AGV_CLEAR
            ok &= ~((X > r[0] - d) & (X < r[2] + d) & (Y > r[1] - d) & (Y < r[3] + d))
    # 終点: シャッターの前（東の壁ぎわ、通路の幅がシャッターに収まる高さ）
    goal = ok & (X >= SITE_W - h - GRID) & (Y >= SHUTTER[0] + h) & (Y <= SHUTTER[1] - h)
    if not goal.any():
        return None
    dist = np.full(ok.shape, -1, dtype=np.int32)
    par = np.full(ok.shape + (2,), -1, dtype=np.int32)
    q = deque()
    for j, i in zip(*np.nonzero(goal)):
        dist[j, i] = 0
        q.append((j, i))
    while q:
        j, i = q.popleft()
        for dj, di in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            a, b = j + dj, i + di
            if 0 <= a < ny and 0 <= b < nx and ok[a, b] and dist[a, b] < 0:
                dist[a, b] = dist[j, i] + 1
                par[a, b] = (j, i)
                q.append((a, b))
    segs, total = [], 0.0
    used = set()
    for k, r, _ in el:
        if k != 'aisle':
            continue
        # 通路の中心線上の升
        if r[2] - r[0] <= r[3] - r[1]:
            i = int(((r[0] + r[2]) / 2) // GRID)
            js = range(max(0, int(r[1] // GRID)), min(ny, int(math.ceil(r[3] / GRID))))
            cand = [(j, i) for j in js if 0 <= i < nx and dist[j, i] >= 0]
        else:
            j = int(((r[1] + r[3]) / 2) // GRID)
            is_ = range(max(0, int(r[0] // GRID)), min(nx, int(math.ceil(r[2] / GRID))))
            cand = [(j, i) for i in is_ if 0 <= j < ny and dist[j, i] >= 0]
        if not cand:
            return None
        j, i = min(cand, key=lambda c: dist[c])
        # 道をたどる
        path = [(j, i)]
        while dist[j, i] > 0:
            j, i = par[j, i]
            path.append((int(j), int(i)))
        new = [c for c in path if c not in used]
        total += len(new) * GRID
        used.update(path)
        # 直線ごとの四角にまとめる
        pts = [((i + 0.5) * GRID, (j + 0.5) * GRID) for j, i in path]
        pts.append((SITE_W, pts[-1][1]))
        s = 0
        for t in range(1, len(pts)):
            if t == len(pts) - 1 or (pts[t + 1][0] != pts[s][0] and pts[t + 1][1] != pts[s][1]):
                (x0, y0), (x1, y1) = pts[s], pts[t]
                if (x0, y0) != (x1, y1):
                    segs.append((min(x0, x1) - h, min(y0, y1) - h, min(SITE_W, max(x0, x1) + h), max(y0, y1) + h))
                s = t
    total += h  # 最後の升からシャッターの面まで
    return segs, total


def aisle_len(el):
    return sum(max(r[2] - r[0], r[3] - r[1]) for k, r, _ in el if k == 'aisle')


# ---- 総当たり ----
def specs(n):
    out = [('1 列', [(n, 'R')])]
    for a in range(math.ceil(n / 2), n):
        b = n - a
        out += [(f'2 列・AGV の通路を共用（{a}＋{b}）', [(a, 'R'), (b, 'L')]),
                (f'2 列・AGV の通路を共用（{b}＋{a}）', [(b, 'R'), (a, 'L')]),
                (f'2 列・AGV の通路を外側に 2 本（{a}＋{b}）', [(a, 'L'), (b, 'R')]),
                (f'2 列・同じ向き（{a}＋{b}）', [(a, 'R'), (b, 'R')]),
                (f'2 列・同じ向き（{b}＋{a}）', [(b, 'R'), (a, 'R')])]
    return out


ROT_JA = {0: '成形機は東西向き', 1: '成形機は南北向き', 2: '成形機は東西向き（180 度回し）', 3: '成形機は南北向き（180 度回し）'}


def candidates(n):
    res = []
    for sname, spec in specs(n):
        for p in PATTERNS:
            for ts in TYPESETS:
                for offs in itertools.product((0, -NOTCH_Y, NOTCH_Y), repeat=len(spec)):
                    if min(offs) < 0 and max(offs) > 0:
                        continue
                    if len(spec) == 1 and offs[0] != 0:
                        continue
                    el0, meta = assemble(n, spec, p, ts, list(offs))
                    if gen_warn(el0):
                        continue
                    for rot in range(4):
                        el1 = transform(el0, rot)
                        b = bbox(el1)
                        w, hh = b[2] - b[0], b[3] - b[1]
                        if w > SITE_W or hh > SITE_H:
                            continue
                        for tx in {0.0, SITE_W - w, NOTCH_X}:
                            for ty in {0.0, NOTCH_Y, SITE_H - hh}:
                                el = transform(el0, rot, tx, ty)
                                if fits(el):
                                    res.append(dict(n=n, structure=sname, spec=spec, pattern=p, typeset=ts, offs=offs,
                                                    rot=rot, tx=tx, ty=ty, el=el, meta=meta))
    return res


def gen_warn(el):
    """重なりの確かめ（gen.check と同じ考え）: 床の物どうし、床の物と通路・引込み、梁どうし"""
    fl = [(e[2] if e[0] == 'machine' else e[2][1], e[1]) for e in el if e[0] in ('machine', 'part')]
    rs = [r for _, r in fl]
    for (i, a), (j, b) in itertools.combinations(fl, 2):
        if i != j and gen.overlaps(a, b):
            return True
    for k, r, _ in el:
        if k == 'aisle' and any(gen.overlaps(r, x) for x in rs):
            return True
    beams = [r for k, r, _ in el if k == 'beam']
    return any(gen.overlaps(a, b) for a, b in itertools.combinations(beams, 2))


def occupied(el, extra=()):
    rs = [e[1] for e in el if e[0] in ('col', 'walk', 'aisle')] + list(extra)
    return gen.union_area(rs)


def evaluate(c):
    r = route(c['el'])
    if r is None:
        return None
    segs, rlen = r
    c['route'] = segs
    c['route_len'] = rlen
    c['occ'] = occupied(c['el'], segs)
    c['agv_len'] = aisle_len(c['el']) + rlen
    return c


def pick(n, cs):
    pref = {'nonop': 0, 'inj': 1, 'clamp': 2, 'op': 3}
    # 同じ組み方・積み方・型・回し方は、置き場所の違いのうち占有の小さいもの（同じなら道の短いもの）だけ
    best = {}
    for c in cs:
        k = (c['structure'], c['pattern'], c['typeset'], c['rot'] % 2)
        key = (round(c['occ'] / 1e6, 1), round(c['route_len'] / 1000))
        if k not in best or key < best[k][0]:
            best[k] = (key, c)
    cs = [v[1] for v in best.values()]
    order = lambda c: (round(c['occ'] / 1e6, 1), c['agv_len'], pref[c['typeset']])
    cs.sort(key=order)
    # 組み方×積み方ごとに型の最良 1 つを並べ、上位 3 つの組み方は型違いも入れる
    reps, seen = [], set()
    for c in cs:
        k = (c['structure'], c['pattern'], c['rot'] % 2)
        if k not in seen:
            seen.add(k)
            reps.append(c)
    out = reps[:18]
    for top in reps[:3]:
        for c in cs:
            if (c['structure'], c['pattern'], c['rot'] % 2) == (top['structure'], top['pattern'], top['rot'] % 2) and c not in out:
                out.append(c)
    # C と D（操作側が空く）の最良は必ず入れる
    for ts in ('nonop',):
        b = next((c for c in cs if c['typeset'] == ts), None)
        if b is not None and b not in out:
            out.append(b)
    out.sort(key=order)
    return out


# ---- 描画 ----
def draw(c, path, background=None):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from matplotlib import font_manager
    from matplotlib.patches import Rectangle, Polygon, FancyArrow
    fp = '/usr/share/fonts/opentype/ipafont-gothic/ipagp.ttf'
    if os.path.exists(fp):
        font_manager.fontManager.addfont(fp)
        plt.rcParams['font.family'] = font_manager.FontProperties(fname=fp).get_name()
    s = 1 / 1000
    fig, ax = plt.subplots(figsize=(11, 13.2), dpi=110)
    ax.set_aspect('equal')
    if background:
        from PIL import Image
        img, x0, y0, mpp = background
        im = Image.open(img)
        ax.imshow(im, extent=(x0 * s, (x0 + im.size[0] * mpp) * s, (y0 + im.size[1] * mpp) * s, y0 * s), alpha=0.45, zorder=0)
    ax.add_patch(Polygon([(x * s, y * s) for x, y in SITE_POLY], closed=True, fill=not background, fc='#fafafa', ec='#222', lw=1.6, zorder=1))
    sty = {
        'walk': dict(fc='#fbf1d6', ec='none', alpha=0.9),
        'aisle': dict(fc='#cfe9cf', ec='#3a8a3a', lw=0.8),
        'machine': dict(fc='#dfe2e6', ec='#666', lw=0.8),
        'clamp': dict(fc='#cfd3d9', ec='none'),
        'inj': dict(fc='#c3c8cf', ec='#999', lw=0.4),
        'opline': dict(fc='#d33', ec='none'),
        'lane': dict(fc='none', ec='#3a8a3a', lw=0.6, ls='--'),
        'beam': dict(fc='none', ec='#2a5fc4', lw=0.8, ls='-.'),
    }
    order = ['walk', 'aisle', 'route', 'machine', 'clamp', 'inj', 'opline', 'lane', 'part', 'beam']
    for kind in order:
        if kind == 'route':
            for r in c['route']:
                ax.add_patch(Rectangle((r[0] * s, r[1] * s), (r[2] - r[0]) * s, (r[3] - r[1]) * s, fc='#cfe9cf', ec='none', zorder=2))
            continue
        for k, r, extra in c['el']:
            if k != kind:
                continue
            st = dict(fc=extra[0], ec='#555', lw=0.5) if k == 'part' else sty[k]
            ax.add_patch(Rectangle((r[0] * s, r[1] * s), (r[2] - r[0]) * s, (r[3] - r[1]) * s, zorder=2, **st))
    for k, r, extra in c['el']:
        if k == 'label':
            ax.text(r[0] * s, r[1] * s, extra, ha='center', va='center', fontsize=10, zorder=3)
        elif k == 'small':
            ax.text(r[0] * s, r[1] * s, extra, ha='center', va='center', fontsize=5.5, color='#555', zorder=3)
    # シャッター
    ax.plot([SITE_W * s, SITE_W * s], [SHUTTER[0] * s, SHUTTER[1] * s], color='#2d7a2d', lw=5, zorder=3)
    ax.add_patch(FancyArrow(SITE_W * s + 0.3, (SHUTTER[0] + SHUTTER[1]) / 2 * s, 2.0, 0, width=0.5, head_width=1.3, head_length=0.9, color='#2d7a2d', zorder=3))
    ax.text(SITE_W * s + 0.4, SHUTTER[0] * s - 0.6, 'シャッター\n（梱包へ）', fontsize=8, color='#2d7a2d', va='bottom')
    ax.text(NOTCH_X / 2 * s, NOTCH_Y / 2 * s, '（敷地の外）', ha='center', va='center', fontsize=8, color='#999')
    ax.set_xlim(-1.5, SITE_W * s + 6)
    ax.set_ylim(SITE_H * s + 1.5, -1.5)
    ax.set_xticks(range(0, 36, 5))
    ax.set_yticks(range(0, 46, 5))
    ax.tick_params(labelsize=7)
    ax.grid(color='#eee', lw=0.5, zorder=0)
    occ = c['occ'] / 1e6
    ax.set_title(f"{c['title']}\n占有 {occ:,.0f} m²（{occ / TSUBO:,.0f} 坪）・1 台あたり {occ / TSUBO / c['n']:.1f} 坪・"
                 f"敷地の残り {(SITE_AREA / 1e6 - occ) / TSUBO:,.0f} 坪　AGV の通路 {c['agv_len'] / 1000:.0f} m（うちシャッターまで {c['route_len'] / 1000:.0f} m）",
                 fontsize=9, loc='left')
    fig.text(0.01, 0.005, '灰: 成形機（数字は番号と型、赤い線が操作側）　色の箱: 帯の装置　青の一点鎖線: 取出機の梁（上空）　'
             '緑: AGV の通路・シャッターまでの道・引込み（破線）　薄い黄: 人の通路　太線: 敷地（工場1・工場2）', fontsize=6.5, color='#444')
    fig.tight_layout(rect=(0, 0.015, 1, 1))
    fig.savefig(path, dpi=110)
    plt.close(fig)
    from PIL import Image
    Image.open(path).convert('RGB').quantize(colors=200 if background else 64, method=Image.Quantize.MEDIANCUT).save(path, optimize=True)


def concerns(c):
    lines = []
    us = c['meta']['units']
    nop = sum(1 for u in us if u.op_band())
    if nop == len(us):
        lines.append('全台、操作側に帯がある（操作盤と操作側の扉の前を帯がふさぐ）')
    elif nop:
        lines.append(f'{nop} 台は操作側に帯、残りは操作側が通路に面して空く')
    else:
        lines.append('全台、操作側が通路に面して空く。反操作側の扉・点検口の前を帯がふさぐ')
    ends = {u.t in 'AC' for u in us}
    lines.append({frozenset({True}): 'AGV の通路が射出側の端を通る（スクリューの抜き取りの場所と重なる）',
                  frozenset({False}): 'AGV の通路は型締側の端、射出側の端は人の通路に面する'}.get(frozenset(ends), '射出側から出入りする台と型締側から出入りする台が混ざる'))
    if c['pattern'] in ('P3s', 'P3n'):
        lines.append('向かい合う帯の間に通路が無い組がある（プレスの型交換は帯の端から）')
    lines.append(f"人の横の通路が AGV の通路を {c['meta']['crossings']} か所で横切る")
    lines.append(f"シャッターまでの道 {c['route_len'] / 1000:.0f} m")
    if c['rot'] % 2 == 1:
        lines.append('成形機が南北向き。型の位置が東西に一直線に並ぶので、クレーンは東西に走るものが要る')
    else:
        lines.append('成形機が東西向き。型の位置が列ごとに南北に一直線に並ぶ')
    free = (SITE_AREA - c['occ']) / 1e6
    lines.append(f'敷地の残り {free:,.0f} m²（梱包・金型の置き場・事務の候補）')
    return lines


def main():
    bg = None
    outdir = HERE
    if len(sys.argv) >= 3:
        # 背景: 室内の図面の画像。左上の角が敷地の原点から (-609.35, -609.35) mm、1 px = 34.82 mm
        bg = (sys.argv[1], -609.35, -609.35, 34.82)
        outdir = sys.argv[2]
        os.makedirs(outdir, exist_ok=True)
    rows = []
    for n in (5, 6, 9, 10, 11):
        cs = candidates(n)
        ev = []
        # 道を探すのは重いので、占有の小さい方から（組み方・積み方・型・向きごとに）
        cs.sort(key=lambda c: occupied(c['el']))
        seen = {}
        for c in cs:
            k = (c['structure'], c['pattern'], c['typeset'], c['rot'] % 2)
            if seen.get(k, 0) >= 4:
                continue
            seen[k] = seen.get(k, 0) + 1
            e = evaluate(c)
            if e:
                ev.append(e)
        out = pick(n, ev)
        print(n, len(cs), len(ev), len(out), [round(c['occ'] / 1e6) for c in out])
        for no, c in enumerate(out, 1):
            c['no'] = no
            types = ''.join(u.t for u in c['meta']['units'])
            c['title'] = f"{n} 台 案 {no}: {c['structure']}、{PATTERNS[c['pattern']]}、{TYPESET_JA[c['typeset']]}、{ROT_JA[c['rot']]}"
            draw(c, os.path.join(outdir, f'{n}台_案{no}.png'), bg)
            occ = c['occ'] / 1e6
            rows.append({
                '台数': n, '案': no, '列の組み方': c['structure'], '積み方': PATTERNS[c['pattern']], '型': TYPESET_JA[c['typeset']],
                '成形機の向き': ROT_JA[c['rot']], '型の並び': types,
                '占有 m2': round(occ, 1), '占有 坪': round(occ / TSUBO, 1), '1台あたり 坪': round(occ / TSUBO / n, 2),
                '共用部 坪': round((occ - n * L * UNIT_DEPTH / 1e6) / TSUBO, 1),
                '敷地の残り 坪': round((SITE_AREA / 1e6 - occ) / TSUBO, 1),
                'AGV 通路 m': round(c['agv_len'] / 1000, 1), 'うちシャッターまで m': round(c['route_len'] / 1000, 1),
                '出入り口の数': 1, '人とAGVの交差': c['meta']['crossings'],
                '操作側に帯の台数': sum(1 for u in c['meta']['units'] if u.op_band()),
                '気になる点': ' / '.join(concerns(c)),
            })
    if not bg:
        with open(os.path.join(outdir, '一覧.csv'), 'w', newline='', encoding='utf-8-sig') as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
    return rows


if __name__ == '__main__':
    main()
