"""成形機 5・6・9・10・11 台の L 字の敷地の案に、製品の保管場所（台車ごと置く）を足す。

使い方: python3 gen_storage.py [背景画像 出力フォルダ]
  引数なし: このフォルダに外形線だけの平面図 PNG と 一覧.csv を書く
  引数あり: 背景画像（室内の図面）を敷いた平面図を、出力フォルダに書く（リポには入れない）

成形機の並べ方は ../20261021/gen_site.py の案をそのまま使う（その資料は変えない）。
保管場所は、成形機の帯の AGV 置き場にある台車（ストッカー）を AGV が台車ごと運んできて、
そのまま床に並べて置く場所として作る。台車 1 台ずつに AGV が直接出し入れできる並べ方にする。
"""
from __future__ import annotations

import csv
import math
import os
import sys
from collections import deque

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.join(os.path.dirname(HERE), '20261021')
sys.path.insert(0, BASE)
import gen  # noqa: E402
import gen_site as gs  # noqa: E402
from gen import L, AISLE, UNIT_DEPTH, TSUBO, PATTERNS, TYPESET_JA  # noqa: E402
from gen_site import SITE_W, SITE_H, NOTCH_X, NOTCH_Y, SITE_AREA, SHUTTER, GRID, AGV_CLEAR, ROT_JA  # noqa: E402

# ---- 保管場所の前提 ----
CART_D = 1100        # 台車の置き場の奥行（AGV が潜り込む向き）。台車 1,090 に余裕 10
CART_W = 900         # 台車の置き場の幅。台車 891 に余裕
CART_GAP = 100       # 隣の台車との隙間（ピッチ 1,000）
BACK_GAP = 100       # 背中合わせの台車の列の隙間
S_AISLE = AISLE      # 保管場所の中の AGV の通路（2,000。台車を載せた AGV がその場で向きを変える）
WALL_MARGIN = 300    # 建物の壁からの余裕（柱・壁の出っ張り）
APRON = (3000, 500)  # シャッターの前に空けておく溜まり（壁から 3 m、シャッターの幅の上下 0.5 m）
MIN_CARTS = 6        # これより少ない区画は作らない
MAX_ZONES = 6
KEYS = int(os.environ.get('KEYS', 24))  # 試す組み方・積み方・型・向きの数（占有の小さい方から）
NEAR = 15000        # シャッター寄りとみなす距離（シャッターの中心から台車の中心まで、直線）


def cells():
    nx, ny = SITE_W // GRID, SITE_H // GRID
    cx = (np.arange(nx) + 0.5) * GRID
    cy = (np.arange(ny) + 0.5) * GRID
    X, Y = np.meshgrid(cx, cy)
    return nx, ny, X, Y


NX, NY, X, Y = cells()


def rect_mask(r, d=0.0):
    """中心が四角（d だけ太らせる）の中に入る升"""
    return (X > r[0] - d) & (X < r[2] + d) & (Y > r[1] - d) & (Y < r[3] + d)


def site_mask(m):
    return (X >= m) & (X <= SITE_W - m) & (Y <= SITE_H - m) & ((Y >= NOTCH_Y + m) | ((X >= NOTCH_X + m) & (Y >= m)))


APRON_R = (SITE_W - APRON[0], SHUTTER[0] - APRON[1], SITE_W, SHUTTER[1] + APRON[1])


def free_mask(el, extra=()):
    """保管場所に使える升（升がまるごと空いているもの）: 敷地の中で、列・通路・道・シャッター前に掛からない"""
    ok = site_mask(WALL_MARGIN + GRID / 2)
    for k, r, _ in el:
        if k in ('col', 'walk', 'aisle', 'machine', 'part', 'lane'):
            ok &= ~rect_mask(r, GRID / 2)
    for r in extra:
        ok &= ~rect_mask(r, GRID / 2)
    ok &= ~rect_mask(APRON_R, GRID / 2)
    return ok


def largest_rect(m):
    """升の真偽表で、True だけの最大の長方形（升の番号 j0, i0, j1, i1、終わりは含まない）"""
    ny, nx = m.shape
    h = np.zeros(nx, dtype=np.int32)
    best = (0, None)
    for j in range(ny):
        h = np.where(m[j], h + 1, 0)
        st = []
        for i in range(nx + 1):
            cur = h[i] if i < nx else 0
            start = i
            while st and st[-1][1] >= cur:
                s, hh = st.pop()
                a = hh * (i - s)
                if a > best[0]:
                    best = (a, (j - hh + 1, s, j + 1, i))
                start = s
            st.append((start, cur))
    return best[1]


def pack(r):
    """四角 r（mm）に台車を並べる。台車の列は通路の両側（背中合わせで次の組）。
    通路の一方の端に、通路をまとめる幹（幅 2 m）を通す。向き 2 × 幹の端 2 の 4 通りから台数の多いもの。
    返り値: [(台数, 台車の四角, 通路の四角, 幹の四角, 幹の端の名前)] を台数の多い順"""
    x0, y0, x1, y1 = r
    out = []
    for horiz in (True, False):          # True: 通路が東西に走る
        lng = (x1 - x0) if horiz else (y1 - y0)
        dep = (y1 - y0) if horiz else (x1 - x0)
        for spine_at_end in (True, False):
            run = lng - S_AISLE
            per = int((run + CART_GAP) // (CART_W + CART_GAP))
            if per <= 0:
                continue
            # 奥行の方向に: 台車・通路・台車 の組を、背中合わせで積む。余りが 3,100 以上なら 片側だけの組
            rows = []   # (種類, 奥行の始まり)
            d = 0.0
            while dep - d >= 2 * CART_D + S_AISLE - 1e-6:
                rows.append(('double', d)); d += 2 * CART_D + S_AISLE + BACK_GAP
            if dep - d >= CART_D + S_AISLE - 1e-6:
                rows.append(('single', d)); d += CART_D + S_AISLE
            if not rows:
                continue
            carts, aisles = [], []
            a0 = S_AISLE if not spine_at_end else 0.0       # 通路の長さの方向の、台車の始まり
            spine = (lng - S_AISLE, lng) if spine_at_end else (0.0, S_AISLE)
            for kind, d0 in rows:
                if kind == 'double':
                    bands = [(d0, d0 + CART_D)]
                    aisle = (d0 + CART_D, d0 + CART_D + S_AISLE)
                    bands.append((aisle[1], aisle[1] + CART_D))
                else:
                    aisle = (d0, d0 + S_AISLE)
                    bands = [(aisle[1], aisle[1] + CART_D)]
                aisles.append((0.0 if not spine_at_end else 0.0, aisle[0], lng, aisle[1]))
                for b0, b1 in bands:
                    for k in range(per):
                        s0 = a0 + k * (CART_W + CART_GAP)
                        carts.append((s0, b0, s0 + CART_W, b1))
            used_dep = d if rows[-1][0] == 'single' else d - BACK_GAP
            spine_r = (spine[0], 0.0, spine[1], used_dep)

            def g(q):
                if horiz:
                    return (x0 + q[0], y0 + q[1], x0 + q[2], y0 + q[3])
                return (x0 + q[1], y0 + q[0], x0 + q[3], y0 + q[2])
            name = ('東西' if horiz else '南北')
            out.append((len(carts), [g(c) for c in carts], [g(a) for a in aisles], g(spine_r), name))
    out.sort(key=lambda t: -t[0])
    return out


def agv_ok(el, carts):
    """AGV（台車を載せて幅 2 m）の中心が通れる升"""
    h = AISLE / 2
    ok = site_mask(h)
    for k, r, _ in el:
        if k in ('machine', 'part'):
            ok &= ~rect_mask(r, h + AGV_CLEAR)
    for r in carts:
        # 台車の脇の通路は幅ちょうど 2 m。升目の粗さの分だけ緩める
        ok &= ~rect_mask(r, h - GRID * 0.75)
    return ok


def bfs(ok):
    h = AISLE / 2
    goal = ok & (X >= SITE_W - h - GRID) & (Y >= SHUTTER[0] + h) & (Y <= SHUTTER[1] - h)
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
            if 0 <= a < NY and 0 <= b < NX and ok[a, b] and dist[a, b] < 0:
                dist[a, b] = dist[j, i] + 1
                par[a, b] = (j, i)
                q.append((a, b))
    return dist, par


def nearest(dist, r):
    """四角 r の中心線上で、シャッターにいちばん近い升"""
    if r[2] - r[0] <= r[3] - r[1]:
        i = int(((r[0] + r[2]) / 2) // GRID)
        cand = [(j, i) for j in range(max(0, int(r[1] // GRID)), min(NY, int(math.ceil(r[3] / GRID)))) if 0 <= i < NX and dist[j, i] >= 0]
    else:
        j = int(((r[1] + r[3]) / 2) // GRID)
        cand = [(j, i) for i in range(max(0, int(r[0] // GRID)), min(NX, int(math.ceil(r[2] / GRID)))) if 0 <= j < NY and dist[j, i] >= 0]
    return min(cand, key=lambda c: dist[c]) if cand else None


def trace(dist, par, starts):
    """升の道を、直線ごとの四角にまとめる。返り値: (四角, 新しく通る長さ mm)"""
    h = AISLE / 2
    segs, total, used = [], 0.0, set()
    for (j, i) in starts:
        path = [(j, i)]
        while dist[j, i] > 0:
            j, i = par[j, i]
            path.append((int(j), int(i)))
        new = [c for c in path if c not in used]
        total += len(new) * GRID
        used.update(path)
        pts = [((i + 0.5) * GRID, (j + 0.5) * GRID) for j, i in path]
        pts.append((SITE_W, pts[-1][1]))
        s = 0
        for t in range(1, len(pts)):
            if t == len(pts) - 1 or (pts[t + 1][0] != pts[s][0] and pts[t + 1][1] != pts[s][1]):
                (xa, ya), (xb, yb) = pts[s], pts[t]
                if (xa, ya) != (xb, yb):
                    segs.append((min(xa, xb) - h, min(ya, yb) - h, min(SITE_W, max(xa, xb) + h), max(ya, yb) + h))
                s = t
    return segs, total + h


def center_cells(r):
    """四角 r の中心線上の升"""
    if r[2] - r[0] <= r[3] - r[1]:
        i = int(((r[0] + r[2]) / 2) // GRID)
        return [(j, i) for j in range(max(0, int(r[1] // GRID)), min(NY, int(math.ceil(r[3] / GRID)))) if 0 <= i < NX]
    j = int(((r[1] + r[3]) / 2) // GRID)
    return [(j, i) for i in range(max(0, int(r[0] // GRID)), min(NX, int(math.ceil(r[2] / GRID)))) if 0 <= j < NY]


def reachable(el, zones, base=None):
    """成形機の通路と保管場所の幹が、台車をよけてシャッターまでつながるか（升のつながりだけを見る）"""
    from scipy import ndimage
    ok = (agv_ok(el, []) if base is None else base.copy())
    h = AISLE / 2
    for z in zones:
        for r in z['carts']:
            ok &= ~rect_mask(r, h - GRID * 0.75)
    lab, _ = ndimage.label(ok)
    goal = ok & (X >= SITE_W - h - GRID) & (Y >= SHUTTER[0] + h) & (Y <= SHUTTER[1] - h)
    gl = set(np.unique(lab[goal])) - {0}
    if not gl:
        return False
    rs = [r for k, r, _ in el if k == 'aisle'] + [z['spine'] for z in zones]
    return all(any(lab[c] in gl for c in center_cells(r)) for r in rs)


def connect(el, zones):
    """道を引く。返り値: (成形機の通路からの道の四角, 保管の区画からの道の四角, 成形機の通路からの道の長さ, 区画ごとのシャッターまでの道のり mm) か None"""
    carts = [c for z in zones for c in z['carts']]
    ok = agv_ok(el, carts)
    dist, par = bfs(ok)
    starts = []
    for k, r, _ in el:
        if k == 'aisle':
            s = nearest(dist, r)
            if s is None:
                return None
            starts.append(s)
    zs = []
    for z in zones:
        s = nearest(dist, z['spine'])
        if s is None:
            return None
        zs.append(s)
    segs, rlen = trace(dist, par, starts)
    zsegs, _ = trace(dist, par, zs)
    zdist = [dist[s] * GRID + AISLE / 2 for s in zs]
    return segs, zsegs, rlen, zdist


def storage(el, route_segs):
    """保管場所を置く。成形機の通路からシャッターまでの最短の道（gen_site の道）は空けたまま、残りの床に取る"""
    best = None
    base = agv_ok(el, [])
    for keep_route in (True,):
        m = free_mask(el, route_segs if keep_route else ())
        zones = []
        for _ in range(MAX_ZONES):
            rr = largest_rect(m)
            if rr is None:
                break
            j0, i0, j1, i1 = rr
            r = (i0 * GRID, j0 * GRID, i1 * GRID, j1 * GRID)
            opts = [o for o in pack(r) if o[0] >= MIN_CARTS]
            placed = None
            for o in opts:
                z = dict(rect=r, n=o[0], carts=o[1], aisles=o[2], spine=o[3], dir=o[4])
                if reachable(el, zones + [z], base):
                    placed = z
                    break
            m[j0:j1, i0:i1] = False
            if placed is None:
                if (j1 - j0) * (i1 - i0) * GRID * GRID < 15e6:
                    break
                continue
            # 区画の外枠は、台車と通路の外接に縮める
            rs = placed['carts'] + placed['aisles'] + [placed['spine']]
            placed['rect'] = (min(q[0] for q in rs), min(q[1] for q in rs), max(q[2] for q in rs), max(q[3] for q in rs))
            zones.append(placed)
        if not zones:
            continue
        c = connect(el, zones)
        if c is None:
            continue
        n = sum(z['n'] for z in zones)
        if best is None or n > best[0]:
            best = (n, zones, c)
    return best


def evaluate(c):
    r = gs.route(c['el'])
    if r is None:
        return None
    segs, rlen = r
    st = storage(c['el'], segs)
    if st is None:
        return None
    n, zones, (rsegs, zsegs, rlen2, zdist) = st
    for z, d in zip(zones, zdist):
        z['dist'] = d
    zones.sort(key=lambda z: z['dist'])
    c['zones'] = zones
    c['carts'] = n
    c['route'] = rsegs + zsegs     # 描く道: 成形機の通路から＋保管の区画から
    c['route_len'] = rlen2
    c['occ'] = gs.occupied(c['el'], rsegs)   # 成形機まわり: 成形機の通路からシャッターまでの道だけを含める
    c['agv_len'] = gs.aisle_len(c['el']) + rlen2
    c['store_area'] = gen.union_area([z['rect'] for z in zones])
    c['used'] = gs.occupied(c['el'], rsegs + zsegs + [z['rect'] for z in zones])
    # シャッターの中心から 15 m 以内（台車の中心までの直線）の台数
    sx, sy = SITE_W, (SHUTTER[0] + SHUTTER[1]) / 2
    c['near'] = sum(1 for z in zones for q in z['carts'] if math.hypot((q[0] + q[2]) / 2 - sx, (q[1] + q[3]) / 2 - sy) <= NEAR)
    c['main_dist'] = min(z['dist'] for z in zones)
    return c


def pick(n, cs):
    # 組み方・積み方・型・向きごとに最良の置き方を 1 つ
    best = {}
    key = lambda c: (-c['carts'], -c['near'], c['main_dist'])
    for c in cs:
        k = (c['structure'], c['pattern'], c['typeset'], c['rot'] % 2)
        if k not in best or key(c) < key(best[k]):
            best[k] = c
    cs = sorted(best.values(), key=key)
    # 組み方×積み方ごとに 1 つ、上位 8 案
    out, seen = [], set()
    for c in cs:
        k = (c['structure'], c['pattern'])
        if k not in seen:
            seen.add(k)
            out.append(c)
        if len(out) >= 8:
            break
    # シャッター寄りがいちばん多い案は必ず入れる
    b = max(cs, key=lambda c: (c['near'], c['carts']))
    if b not in out:
        out.append(b)
    out.sort(key=key)
    return out


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
    ax.add_patch(Polygon([(x * s, y * s) for x, y in gs.SITE_POLY], closed=True, fill=not background, fc='#fafafa', ec='#222', lw=1.6, zorder=1))
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

    def box(r, **kw):
        ax.add_patch(Rectangle((r[0] * s, r[1] * s), (r[2] - r[0]) * s, (r[3] - r[1]) * s, **kw))
    for kind in ['walk', 'aisle', 'route', 'store', 'machine', 'clamp', 'inj', 'opline', 'lane', 'part', 'beam']:
        if kind == 'route':
            for r in c['route']:
                box(r, fc='#cfe9cf', ec='none', zorder=2)
            continue
        if kind == 'store':
            for zi, z in enumerate(c['zones'], 1):
                box(z['rect'], fc='#fff3e0', ec='#d9822b', lw=1.2, ls='--', zorder=2)
                for r in z['aisles'] + [z['spine']]:
                    box(r, fc='#cfe9cf', ec='none', zorder=2.1)
                for r in z['carts']:
                    box(r, fc='#f2b56b', ec='#a85c12', lw=0.4, zorder=2.2)
                zr = z['rect']
                ax.text((zr[0] + zr[2]) / 2 * s, (zr[1] + zr[3]) / 2 * s, f"保管 {zi}\n{z['n']} 台", ha='center', va='center',
                        fontsize=9, color='#7a3d00', zorder=3, bbox=dict(fc='white', ec='none', alpha=0.75, pad=1.5))
            continue
        for k, r, extra in c['el']:
            if k != kind:
                continue
            st = dict(fc=extra[0], ec='#555', lw=0.5) if k == 'part' else sty[k]
            box(r, zorder=2, **st)
    for k, r, extra in c['el']:
        if k == 'label':
            ax.text(r[0] * s, r[1] * s, extra, ha='center', va='center', fontsize=10, zorder=3)
        elif k == 'small':
            ax.text(r[0] * s, r[1] * s, extra, ha='center', va='center', fontsize=5.5, color='#555', zorder=3)
    box(APRON_R, fc='none', ec='#2d7a2d', lw=0.6, ls=':', zorder=2)
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
    sa = c['store_area'] / 1e6
    ax.set_title(f"{c['title']}\n保管 台車 {c['carts']} 台（うちシャッターから 15 m 以内 {c['near']} 台）・保管場所 {sa:,.0f} m²（{sa / TSUBO:,.0f} 坪）・"
                 f"いちばん近い区画からシャッターまで {c['main_dist'] / 1000:.0f} m\n"
                 f"成形機まわりの占有 {c['occ'] / 1e6:,.0f} m²（{c['occ'] / 1e6 / TSUBO:,.0f} 坪）　AGV の通路 {c['agv_len'] / 1000:.0f} m（うちシャッターまで {c['route_len'] / 1000:.0f} m）",
                 fontsize=9, loc='left')
    fig.text(0.01, 0.005, '橙の箱: 保管の台車（1 台 1,100 × 900 の枠）　橙の破線: 保管の区画　緑: AGV の通路・道・保管場所の通路　'
             '点線: シャッター前の溜まり　灰: 成形機　色の箱: 帯の装置　薄い黄: 人の通路', fontsize=6.5, color='#444')
    fig.tight_layout(rect=(0, 0.015, 1, 1))
    fig.savefig(path, dpi=110)
    plt.close(fig)
    from PIL import Image
    Image.open(path).convert('RGB').quantize(colors=200 if background else 64, method=Image.Quantize.MEDIANCUT).save(path, optimize=True)


def concerns(c):
    lines = []
    zs = c['zones']
    lines.append(f"保管の区画 {len(zs)} か所（" + '、'.join(f"{z['n']} 台・{z['dist'] / 1000:.0f} m" for z in zs) + '、台数・シャッターまでの道のり）')
    if c['near'] == 0:
        lines.append('シャッターから 15 m 以内に保管の台車が無い')
    us = c['meta']['units']
    nop = sum(1 for u in us if u.op_band())
    lines.append('全台、操作側に帯' if nop == len(us) else ('全台、操作側が空く' if nop == 0 else f'{nop} 台は操作側に帯'))
    lines.append(f"人の横の通路が AGV の通路を {c['meta']['crossings']} か所で横切る")
    return lines


def main():
    bg = None
    outdir = HERE
    if len(sys.argv) >= 3:
        bg = (sys.argv[1], -609.35, -609.35, 34.82)
        outdir = sys.argv[2]
        os.makedirs(outdir, exist_ok=True)
    # BG=背景画像:出力フォルダ で、外形線の版と一緒に背景つきの版も描く
    bg_env = os.environ.get('BG', '').split(':') if os.environ.get('BG') else None
    if bg_env:
        os.makedirs(bg_env[1], exist_ok=True)
    only = [int(a) for a in os.environ.get('ONLY', '').split(',') if a]
    rows = []
    for n in only or (5, 6, 9, 10, 11):
        cs = gs.candidates(n)
        # 占有の小さい組み方・積み方・型・向きから。置き場所（左上・右下など）は全部試す
        groups = {}
        for c in cs:
            k = (c['structure'], c['pattern'], c['typeset'], c['rot'] % 2)
            groups.setdefault(k, []).append(c)
        occ_k = {k: gs.occupied(v[0]['el']) for k, v in groups.items()}
        keys = sorted(groups, key=lambda k: occ_k[k])
        lim = min(occ_k.values()) * 1.12
        keys = [k for k in keys if occ_k[k] <= lim][:KEYS]
        ev = []
        for k in keys:
            seenpos = set()
            for c in groups[k]:
                pos = (c['rot'], round(c['tx']), round(c['ty']), c['offs'])
                if pos in seenpos:
                    continue
                seenpos.add(pos)
                e = evaluate(c)
                if e:
                    ev.append(e)
        out = pick(n, ev)
        print(n, len(cs), len(keys), len(ev), [(c['carts'], c['near']) for c in out], flush=True)
        for no, c in enumerate(out, 1):
            c['no'] = no
            c['title'] = f"{n} 台 案 {no}: {c['structure']}、{PATTERNS[c['pattern']]}、{TYPESET_JA[c['typeset']]}、{ROT_JA[c['rot']]}"
            draw(c, os.path.join(outdir, f'{n}台_案{no}.png'), bg)
            if bg_env:
                draw(c, os.path.join(bg_env[1], f'{n}台_案{no}.png'), (bg_env[0], -609.35, -609.35, 34.82))
            occ = c['occ'] / 1e6
            sa = c['store_area'] / 1e6
            rows.append({
                '台数': n, '案': no, '列の組み方': c['structure'], '積み方': PATTERNS[c['pattern']], '型': TYPESET_JA[c['typeset']],
                '成形機の向き': ROT_JA[c['rot']], '型の並び': ''.join(u.t for u in c['meta']['units']),
                '保管の台車 台': c['carts'], 'うちシャッターから15m以内 台': c['near'],
                '保管場所 m2': round(sa, 1), '保管場所 坪': round(sa / TSUBO, 1), '保管の区画数': len(c['zones']),
                'いちばん近い区画からシャッターまで m': round(c['main_dist'] / 1000, 1),
                '成形機まわりの占有 坪': round(occ / TSUBO, 1),
                '敷地の残り 坪': round((SITE_AREA - c['used']) / 1e6 / TSUBO, 1),
                'AGV 通路 m': round(c['agv_len'] / 1000, 1), 'うちシャッターまで m': round(c['route_len'] / 1000, 1),
                '気になる点': ' / '.join(concerns(c)),
            })
    if not bg:
        with open(os.path.join(outdir, '一覧.csv' if not only else f'一覧-{"-".join(map(str, only))}.csv'), 'w', newline='', encoding='utf-8-sig') as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
    return rows


if __name__ == '__main__':
    main()
