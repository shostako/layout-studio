"""工場1 に成形機 6 台（防火壁あり）、工場2 を製品のストッカー置き場にする並べ方のバリエーションを作る。

使い方: python3 gen_f2.py [背景画像 出力フォルダ]
  引数なし: このフォルダに外形線だけの平面図 PNG と 一覧.csv を書く
  引数あり: 背景画像（室内の図面）を敷いた平面図を、出力フォルダにも書く（リポには入れない）

成形機の並べ方は ../20261021-工場1に6台/ のおすすめ（案 2）に固定し、工場2 の中の並べ方だけを変える。
- 2 列ずつ: AGV の通路の両側に台を 1 台ずつ並べ、その列を背中合わせで 2 列ずつにする（どの台も直接出し入れできる）
- 詰め: 台を列にまとめて隙間だけで並べ、AGV の通路は列の端にだけ通す
防火壁・防火シャッターの扱いは ../20261021-防火壁/ と同じ（gen_f1.py の値をそのまま使う）。
"""
from __future__ import annotations

import csv
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), '20261021-工場1に6台'))
import gen_f1 as f1  # noqa: E402
import gen  # noqa: E402
import gen_storage as st  # noqa: E402
from gen import TSUBO  # noqa: E402

# ---- ストッカーの台（../20261021-保管場所-詰め/ と同じ仮の値）----
CART_L = 1200        # AGV が潜り込む向きの長さ（列の向き）
CART_W = 1100        # それと直角の幅
GAP = 100            # 台どうしの隙間（列の中も、列どうしも）
S_AISLE = 2000       # AGV の通路
BACK = 100           # 背中合わせの 2 列の間
DAILY = 4            # 成形機 1 台で 1 日に満杯になる台
N = f1.N

# 工場2 の床（壁から 300）。x 300〜15,000、y 6,700〜45,400
RX0, RY0, RX1, RY1 = f1.F2_IN
# 開口の高さに合わせた東西の通路（AGV の中心が開口の幅に入る）
N_AISLE = (8000, 10000)
S_AISLE_Y = (39550, 41550)

# 工場2 の台は直したので、工場1 の残り（参考）も同じ台で数える
st.CART_D, st.CART_W, st.CART_GAP = CART_L, CART_W, GAP


def lanes(x0, y0, x1, y1, along):
    """四角に台の列を詰める。along='y': 列は南北（台の 1,200 が南北）、'x': 東西。返り値: 列（台の四角のリスト）のリスト"""
    out = []
    if along == 'y':
        nl = int((x1 - x0 + GAP) // (CART_W + GAP))
        nc = int((y1 - y0 + GAP) // (CART_L + GAP))
        for i in range(nl):
            xa = x0 + i * (CART_W + GAP)
            out.append([(xa, y0 + k * (CART_L + GAP), xa + CART_W, y0 + k * (CART_L + GAP) + CART_L) for k in range(nc)])
    else:
        nl = int((y1 - y0 + GAP) // (CART_W + GAP))
        nc = int((x1 - x0 + GAP) // (CART_L + GAP))
        for i in range(nl):
            ya = y0 + i * (CART_W + GAP)
            out.append([(x0 + k * (CART_L + GAP), ya, x0 + k * (CART_L + GAP) + CART_L, ya + CART_W) for k in range(nc)])
    return [l for l in out if l]


def row(x0, y0, x1, y1, along):
    """通路に面した 1 台の奥行の列（台は通路と直角に潜り込む）。along は通路の向き"""
    if along == 'x':      # 東西の通路に面する: 台の 1,200 が南北
        return lanes(x0, y0, x1, y0 + CART_L, 'y')
    return lanes(x0, y0, x0 + CART_L, y1, 'x')


def stack_pairs(a0, a1, b0, b1, along, start_with_aisle=False):
    """通路の向き along に、[列][通路][列] の組を背中合わせで積む（2 列ずつ）。
    a は通路の向きの範囲、b は積む向きの範囲。返り値: (列のリスト, 通路の四角のリスト)"""
    ls, ais = [], []
    d = b0
    if start_with_aisle:
        ais.append((d, d + S_AISLE)); d += S_AISLE
        ls.append((d, d + CART_L)); d += CART_L + BACK
    while b1 - d >= 2 * CART_L + S_AISLE - 1e-6:
        ls.append((d, d + CART_L)); d += CART_L
        ais.append((d, d + S_AISLE)); d += S_AISLE
        ls.append((d, d + CART_L)); d += CART_L + BACK
    if b1 - d >= CART_L + S_AISLE - 1e-6:
        ais.append((d, d + S_AISLE)); d += S_AISLE
        ls.append((d, d + CART_L)); d += CART_L
    lanes_, aisles = [], []
    for c0, c1 in ls:
        lanes_ += row(a0, c0, a1, c1, 'x') if along == 'x' else row(c0, a0, c1, a1, 'y')
    for c0, c1 in ais:
        aisles.append((a0, c0, a1, c1) if along == 'x' else (c0, a0, c1, a1))
    return lanes_, aisles


# ---- バリエーション ----
SPINE_E = (RX1 - S_AISLE, RY0, RX1, RY1)          # 防火壁ぎわの幹（2 つの開口の前を通る）
SPINE_W = (RX0, RY0, RX0 + S_AISLE, RY1)          # 西の壁ぎわの幹


def v_w1():
    ls, ais = stack_pairs(RX0, SPINE_E[0], RY0, RY1, 'x')
    return dict(kind='2 列ずつ', name='東西の通路・幹は防火壁ぎわ', lanes=ls, aisles=ais + [SPINE_E], main=SPINE_E,
                note='通路は東西に走り、東の端で防火壁ぎわの幹につながる（西の端は行き止まり）')


def v_w2():
    ls, ais = stack_pairs(SPINE_W[2], SPINE_E[0], RY0, RY1, 'x')
    return dict(kind='2 列ずつ', name='東西の通路・幹を両側に', lanes=ls, aisles=ais + [SPINE_E, SPINE_W], main=SPINE_E,
                note='通路の両端に幹があり、AGV は通路を一方向に通り抜けられる')


def v_w3():
    # 北の開口の高さと南の開口の高さに東西の幹。その間は南北の通路で 2 列ずつ。北と南の端は幹に面した 1 列
    nA = (RX0, N_AISLE[0], RX1, N_AISLE[1])
    sA = (RX0, S_AISLE_Y[0], RX1, S_AISLE_Y[1])
    ls, ais = stack_pairs(N_AISLE[1], S_AISLE_Y[0], RX0, RX1, 'y')
    ls += row(RX0, N_AISLE[0] - CART_L, RX1, N_AISLE[0], 'x')
    ls += row(RX0, S_AISLE_Y[1], RX1, S_AISLE_Y[1] + CART_L, 'x')
    return dict(kind='2 列ずつ', name='南北の通路・開口の高さに東西の幹', lanes=ls, aisles=ais + [nA, sA], main=sA,
                note='南北の通路は両端で、2 つの開口に真っすぐつながる東西の幹に出る')


def v_d1():
    # 南北の列。北と南の壁ぎわに通路（北が入口、南が出口）
    nA = (RX0, RY0, RX1, RY0 + S_AISLE)
    sA = (RX0, RY1 - S_AISLE, RX1, RY1)
    ls = lanes(RX0, nA[3], RX1, sA[1], 'y')
    return dict(kind='詰め', name='南北の列・北と南の壁ぎわに通路', lanes=ls, aisles=[nA, sA], main=sA,
                note='北の通路から入れ、南の通路から出す。1 列が長い（../20261021-工場1に6台-詰め/ の本命と同じ形）')


def v_d2():
    # 東西の短い列。西の壁ぎわと防火壁ぎわに幹、開口の高さに東西の通路（幹どうしをつなぐ）
    nA = (SPINE_W[2], N_AISLE[0], SPINE_E[0], N_AISLE[1])
    sA = (SPINE_W[2], S_AISLE_Y[0], SPINE_E[0], S_AISLE_Y[1])
    ls = []
    for y0, y1 in ((RY0, nA[1]), (nA[3], sA[1]), (sA[3], RY1)):
        ls += lanes(SPINE_W[2], y0, SPINE_E[0], y1, 'x')
    return dict(kind='詰め', name='東西の短い列・西と東に幹', lanes=ls, aisles=[SPINE_W, SPINE_E, nA, sA], main=SPINE_E,
                note='西の幹から入れ、防火壁ぎわの幹から出す。1 列が短く、列を空にする回りが速い')


def v_d3():
    # 南北の列。開口の高さに東西の通路を通し、間の列は両端から、北と南の端の列は片側から出し入れ
    nA = (RX0, N_AISLE[0], RX1, N_AISLE[1])
    sA = (RX0, S_AISLE_Y[0], RX1, S_AISLE_Y[1])
    ls = lanes(RX0, nA[3], RX1, sA[1], 'y')
    ls += lanes(RX0, RY0, RX1, nA[1], 'y')
    ls += lanes(RX0, sA[3], RX1, RY1, 'y')
    return dict(kind='詰め', name='南北の列・開口の高さに東西の通路', lanes=ls, aisles=[nA, sA], main=sA,
                note='間の長い列は北の通路から入れて南の通路から出す。2 つの通路が開口に真っすぐつながる。北と南の端の短い列は片側からの出し入れ')


VARIANTS = [v_w1, v_w2, v_w3, v_d1, v_d2, v_d3]


def _draw_fn():
    """gen_f1.draw の凡例の台の大きさだけを、この資料の台に直した写し（gen_f1 自体は変えない）"""
    import inspect
    src = inspect.getsource(f1.draw).replace('1 台 1,100 × 900 の枠', '1 台 1,200 × 1,100')
    ns = dict(f1.__dict__)
    exec(src, ns)
    return ns['draw']


draw = _draw_fn()


def touches_aisle(c, aisles, d=1150):
    """台の潜り込む向き（1,200 の向き）の前か後ろ d 以内に通路がある＝ほかの台を動かさずに出し入れできる"""
    if abs((c[2] - c[0]) - CART_L) < 1:
        g = (c[0] - d, c[1], c[2] + d, c[3])
    else:
        g = (c[0], c[1] - d, c[2], c[3] + d)
    return any(gen.overlaps(g, a) for a in aisles)


def finish(v):
    """開口の前の台を抜き、数を数える"""
    keep = []
    for l in v['lanes']:
        l2 = [c for c in l if not any(gen.overlaps(c, a) for a in f1.APRONS)]
        if l2:
            keep.append(l2)
    v['lanes'] = keep
    carts = [c for l in keep for c in l]
    v['carts'] = carts
    v['n'] = len(carts)
    v['longest'] = max(len(l) for l in keep)
    rs = carts + v['aisles']
    v['rect'] = (min(q[0] for q in rs), min(q[1] for q in rs), max(q[2] for q in rs), max(q[3] for q in rs))
    return v


def machine_plan():
    """../20261021-工場1に6台/ の案 2（C と D、AGV の通路は防火壁の側、列は東の壁に寄せて北の端）"""
    for c in f1.candidates():
        if c['pattern'] == 'P3s' and c['typeset'] == 'nonop' and c['rot'] == 2 and abs(c['tx'] - (f1.F1[2] - c['w'])) < 1 and c['ty'] == 0:
            return c
    raise SystemExit('案 2 が見つからない')


def all_aisles_reach(el, v):
    from scipy import ndimage
    ok = f1.agv_ok(el, v['carts'])
    lab, _ = ndimage.label(ok)
    gl = set(np.unique(lab[f1.EAST_GOAL & ok])) - {0}
    return bool(gl) and all(any(lab[q] in gl for q in st.center_cells(a)) for a in v['aisles'])


def main():
    bg = (sys.argv[1], sys.argv[2]) if len(sys.argv) >= 3 else None
    if bg:
        os.makedirs(bg[1], exist_ok=True)
    base = machine_plan()
    rows = []
    for no, fn in enumerate(VARIANTS, 1):
        v = finish(fn())
        z2 = dict(rect=v['rect'], carts=v['carts'], n=v['n'], aisles=[a for a in v['aisles'] if a is not v['main']],
                  spine=v['main'], dir=v['name'])
        c = dict(base)
        c = f1.evaluate(c, [z2])
        if c is None or not all_aisles_reach(c['el'], v):
            print(no, v['name'], 'つながらない', flush=True)
            continue
        days = v['n'] / (N * DAILY)
        c['title'] = f"工場2 案 {no}（{v['kind']}）: {v['name']}　成形機は ../20261021-工場1に6台/ の案 2"
        draw(c, os.path.join(HERE, f'工場2_案{no}.png'))
        if bg:
            draw(c, os.path.join(bg[1], f'工場2_案{no}.png'), (bg[0], -609.35, -609.35, 34.82))
        area = gen.union_area([v['rect']]) / 1e6
        direct = sum(1 for q in v['carts'] if touches_aisle(q, v['aisles']))
        rows.append({
            '案': no, '並べ方': v['kind'], '形': v['name'], '台': v['n'], '何日分': round(days, 1),
            'すぐ出し入れできる台': direct, 'いちばん長い列 台': v['longest'], '列の数': len(v['lanes']) if v['kind'] == '詰め' else '',
            '保管場所 m2': round(area, 1), '保管場所 坪': round(area / TSUBO, 1), '1 坪あたり 台': round(v['n'] / (area / TSUBO), 2),
            '成形機→開口 m': round(c['m_o'] / 1000, 1), '工場2→シャッター m': round(c['s_e'] / 1000, 1),
            '工場1 の残り 台（参考）': c['carts1'], '説明': v['note'],
        })
        print(no, v['kind'], v['name'], v['n'], v['longest'], round(c['m_o']), round(c['s_e']), c['carts1'], flush=True)
    with open(os.path.join(HERE, '一覧.csv'), 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)


if __name__ == '__main__':
    main()
