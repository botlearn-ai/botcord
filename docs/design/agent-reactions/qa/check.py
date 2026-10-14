"""Visual + interaction check for index.html over a leased CDP Chrome.
Usage: uv run --with playwright python -I qa/check.py <websocket_url>
"""
import json, pathlib, sys
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
URL = (ROOT / "index.html").as_uri()
SHOTS = ROOT / "screenshots"
SCHEMES = ["A", "B", "C", "D", "E"]
SCENARIOS = ["thinking", "mixed", "all", "legacy", "crowded", "replay"]
problems, log = [], []

PROBE = """() => {
  const loops = document.getAnimations().filter(a => a.effect && a.effect.getComputedTiming().iterations === Infinity && a.playState === 'running');
  const imgs = [...document.querySelectorAll('img')].filter(i => !i.complete || i.naturalWidth === 0).length;
  const overflow = document.documentElement.scrollWidth > window.innerWidth + 1;
  // reaction rows must not show visible text other than counts like +5 / 3
  const texts = [...document.querySelectorAll('.rx')].map(r => {
    const c = r.cloneNode(true); c.querySelectorAll('.tip').forEach(t => t.remove());
    return c.textContent.replace(/\\s+/g, '');
  }).filter(t => t && !/^[+0-9·]*$/.test(t));
  // reaction elements must stay inside their device frame
  let outside = 0;
  document.querySelectorAll('.device').forEach(d => {
    const dr = d.getBoundingClientRect();
    d.querySelectorAll('.rx').forEach(r => { const rr = r.getBoundingClientRect(); if (rr.left < dr.left - 1 || rr.right > dr.right + 1) outside++; });
  });
  return { loops: loops.length, brokenImgs: imgs, overflow, texts, outside };
}"""

def goto(page, **kw):
    q = "&".join(f"{k}={v}" for k, v in kw.items())
    page.goto(f"{URL}?{q}")
    page.wait_for_timeout(150)

with sync_playwright() as p:
    browser = p.chromium.connect_over_cdp(sys.argv[1])
    ctx = browser.contexts[0]
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: m.type == "error" and errors.append(m.text))

    # 1) matrix: schemes x scenarios x widths, both themes, both motion modes
    for vw, width in [(320, "fit"), (375, "fit"), (430, "fit"), (1440, "desktop"), (1440, "320")]:
        page.set_viewport_size({"width": vw, "height": 900})
        for scheme in SCHEMES + ["ALL"]:
            for scn in SCENARIOS:
                for theme in ["light", "dark"]:
                    for motion in ["auto", "reduce"]:
                        steps = range(6) if scn == "replay" and theme == "light" and motion == "auto" else [0]
                        for st in steps:
                            goto(page, scheme=scheme, scenario=scn, width=width, theme=theme, motion=motion, step=st)
                            r = page.evaluate(PROBE)
                            tag = f"{vw}/{width}/{scheme}/{scn}/{theme}/{motion}/step{st}"
                            limit = 0 if (motion == "reduce" or scheme == "ALL") else 1
                            if r["loops"] > limit: problems.append(f"{tag}: {r['loops']} loop animations")
                            if r["brokenImgs"]: problems.append(f"{tag}: {r['brokenImgs']} broken imgs")
                            if r["overflow"]: problems.append(f"{tag}: horizontal page overflow")
                            if r["texts"]: problems.append(f"{tag}: text in rows {r['texts']}")
                            if r["outside"]: problems.append(f"{tag}: {r['outside']} rows outside device")
    log.append("matrix done")

    # 2) desktop interactions
    page.set_viewport_size({"width": 1440, "height": 900})
    goto(page, scheme="A", scenario="mixed", width="desktop", theme="light")
    first = page.locator('[role="toolbar"]').last.locator(".rx-item").first
    first.focus()
    tip_op = first.locator(".tip").evaluate("e => getComputedStyle(e).opacity")
    page.keyboard.press("ArrowRight")
    focused = page.evaluate("document.activeElement.getAttribute('aria-label')")
    log.append(f"focus tip opacity(after transition may be <1): {tip_op}; ArrowRight -> {focused}")
    page.keyboard.press("Enter")
    page.wait_for_timeout(300)
    pop = page.locator(".layer.open .pop")
    if not pop.count(): problems.append("desktop: Enter did not open detail")
    else:
        txt = pop.inner_text()
        log.append("detail: " + txt.replace("\n", " | "))
        page.screenshot(path=str(SHOTS / "desktop-A-mixed-detail-light.png"))
        page.keyboard.press("Escape")
        page.wait_for_timeout(250)
        back = page.evaluate("document.activeElement.getAttribute('aria-label')")
        if back != focused: problems.append(f"focus not restored: {back} vs {focused}")
    # unknown detail text check
    goto(page, scheme="A", scenario="legacy", width="desktop")
    page.locator('[data-detail="1|mira"]').click(); page.wait_for_timeout(250)
    t = page.locator(".layer.open .pop").inner_text()
    if "不代表被忽略" not in t: problems.append("unknown detail missing 不代表被忽略")
    page.screenshot(path=str(SHOTS / "desktop-A-legacy-unknown-detail.png"))
    page.keyboard.press("Escape")
    # lease timeout -> interrupted derived
    goto(page, scheme="A", scenario="mixed", width="desktop")
    page.locator('[data-detail="1|juno"]').click(); page.wait_for_timeout(250)
    t = page.locator(".layer.open .pop").inner_text()
    if "系统推断" not in t or "租约" not in t: problems.append("interrupted detail missing derived/lease")
    page.keyboard.press("Escape")
    # +N list in crowded
    goto(page, scheme="A", scenario="crowded", width="desktop")
    page.locator('[data-list="1|all"]').first.click(); page.wait_for_timeout(250)
    n = page.locator(".layer.open .list [data-sub]").count()
    if n != 12: problems.append(f"crowded list shows {n} rows")
    page.locator(".layer.open .list [data-sub]").nth(3).click(); page.wait_for_timeout(100)
    page.screenshot(path=str(SHOTS / "desktop-A-crowded-list-detail.png"))
    page.locator(".layer.open [data-back]").click(); page.wait_for_timeout(100)
    if page.locator(".layer.open .list").count() != 1: problems.append("back to list failed")
    page.keyboard.press("Escape")
    # every scheme desktop: open first trigger
    for s in SCHEMES:
        goto(page, scheme=s, scenario="crowded", width="desktop")
        page.locator(".device .rx-item").first.click(); page.wait_for_timeout(250)
        if not page.locator(".layer.open .pop").count(): problems.append(f"{s}: click opened nothing")
        page.keyboard.press("Escape")

    # 3) phone interactions (real 375 viewport)
    page.set_viewport_size({"width": 375, "height": 812})
    for s in SCHEMES:
        goto(page, scheme=s, scenario="mixed", width="fit")
        btn = page.locator(".rx-row-btn").last
        h = btn.bounding_box()["height"]
        if h < 44: problems.append(f"phone {s}: row target {h}px")
        btn.click(); page.wait_for_timeout(300)
        if not page.locator(".layer.open.sheet-mode .list").count(): problems.append(f"phone {s}: sheet not open")
        if s == "A":
            page.screenshot(path=str(SHOTS / "phone375-A-mixed-sheet.png"))
            page.locator(".layer.open .list [data-sub]").nth(1).click(); page.wait_for_timeout(200)
            page.screenshot(path=str(SHOTS / "phone375-A-mixed-sheet-detail.png"))
        page.locator(".layer.open .scrim").click(position={"x": 10, "y": 10}); page.wait_for_timeout(250)
        if page.locator(".layer.open").count(): problems.append(f"phone {s}: scrim did not close")

    # 4) screenshots
    shots = [
        (1440, dict(scheme="ALL", scenario="mixed", width="375", theme="light"), "compare-mixed-light"),
        (1440, dict(scheme="ALL", scenario="mixed", width="375", theme="dark"), "compare-mixed-dark"),
        (1440, dict(scheme="ALL", scenario="all", width="375", theme="light"), "compare-all-states-light"),
        (1440, dict(scheme="ALL", scenario="crowded", width="375", theme="dark"), "compare-crowded-dark"),
        (1440, dict(scheme="ALL", scenario="legacy", width="375", theme="light"), "compare-legacy-light"),
        (1440, dict(scheme="A", scenario="all", width="desktop", theme="light"), "desktop-A-all-light"),
        (1440, dict(scheme="A", scenario="all", width="desktop", theme="dark"), "desktop-A-all-dark"),
        (320, dict(scheme="A", scenario="crowded", width="fit", theme="light"), "phone320-A-crowded-light"),
        (430, dict(scheme="A", scenario="mixed", width="fit", theme="dark"), "phone430-A-mixed-dark"),
        (375, dict(scheme="B", scenario="crowded", width="fit", theme="light"), "phone375-B-crowded-light"),
        (375, dict(scheme="A", scenario="thinking", width="fit", theme="dark"), "phone375-A-thinking-dark"),
    ]
    for vw, kw, name in shots:
        page.set_viewport_size({"width": vw, "height": 900})
        goto(page, **kw)
        page.wait_for_timeout(200)
        page.screenshot(path=str(SHOTS / f"{name}.png"), full_page=True)
    # zoomed rows: element shots of every scheme's last row in the all-states scenario
    page.set_viewport_size({"width": 1440, "height": 900})
    for theme in ["light", "dark"]:
        goto(page, scheme="ALL", scenario="all", width="430", theme=theme)
        for i, d in enumerate(page.locator(".device").all()):
            d.locator(".chat").screenshot(path=str(SHOTS / f"rows-all-{SCHEMES[i]}-{theme}.png"))
    for st in range(6):
        goto(page, scheme="A", scenario="replay", width="desktop", step=st)
        page.locator(".device .chat").screenshot(path=str(SHOTS / f"replay-A-step{st+1}.png"))

    if errors: problems.append(f"console errors: {errors[:5]}")
    print(json.dumps({"problems": problems, "log": log}, ensure_ascii=False, indent=1))
