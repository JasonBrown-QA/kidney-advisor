"""Generate kidney-shaped PNG icons for the PWA."""
from PIL import Image, ImageDraw, ImageFilter

BG_TOP = (10, 140, 176)   # teal top
BG_BOT = (8, 90, 120)     # teal bottom
KIDNEY = (255, 255, 255)
INNER = (10, 110, 145)    # back-color cutout for inner curve

def make_icon(size):
    # Work at 4x size then downsample for smooth edges
    s = size * 4
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))

    # Vertical teal gradient background
    bg = Image.new("RGB", (s, s), BG_TOP)
    bd = ImageDraw.Draw(bg)
    for y in range(s):
        t = y / s
        r = int(BG_TOP[0] * (1 - t) + BG_BOT[0] * t)
        g = int(BG_TOP[1] * (1 - t) + BG_BOT[1] * t)
        b = int(BG_TOP[2] * (1 - t) + BG_BOT[2] * t)
        bd.line([(0, y), (s, y)], fill=(r, g, b))

    # Rounded-square mask for the background
    mask = Image.new("L", (s, s), 0)
    md = ImageDraw.Draw(mask)
    radius = int(s * 0.22)
    md.rounded_rectangle((0, 0, s, s), radius=radius, fill=255)
    img.paste(bg, (0, 0), mask)

    # Kidney bean shape — draw on a separate layer
    kidney_layer = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    kd = ImageDraw.Draw(kidney_layer)

    cx, cy = s / 2, s / 2
    # Outer kidney bean: composite of overlapping ellipses
    # Big rounded body — tall ellipse
    body_w = int(s * 0.55)
    body_h = int(s * 0.70)
    kd.ellipse((cx - body_w/2, cy - body_h/2, cx + body_w/2, cy + body_h/2), fill=KIDNEY)
    # Top lobe bulge — shift up-right
    lobe_w = int(s * 0.40)
    lobe_h = int(s * 0.42)
    kd.ellipse((cx - lobe_w/2 + s*0.05, cy - body_h/2 - s*0.02,
                cx + lobe_w/2 + s*0.05, cy - body_h/2 + lobe_h - s*0.02), fill=KIDNEY)
    # Bottom lobe bulge — shift down-right
    kd.ellipse((cx - lobe_w/2 + s*0.05, cy + body_h/2 - lobe_h + s*0.02,
                cx + lobe_w/2 + s*0.05, cy + body_h/2 + s*0.02), fill=KIDNEY)

    # Inner curve indentation (left side) — cut a notch using BG color
    notch_w = int(s * 0.22)
    notch_h = int(s * 0.28)
    notch_x = cx - body_w/2 - notch_w*0.20
    notch_y = cy - notch_h/2
    # Draw using transparent to "erase" from kidney layer
    kd.ellipse((notch_x, notch_y, notch_x + notch_w, notch_y + notch_h),
               fill=(0, 0, 0, 0))
    # Actually erasing requires a mask op:
    erase_mask = Image.new("L", (s, s), 0)
    em = ImageDraw.Draw(erase_mask)
    em.ellipse((notch_x, notch_y, notch_x + notch_w, notch_y + notch_h), fill=255)
    # Apply erase
    px = kidney_layer.load()
    em_px = erase_mask.load()
    for y in range(s):
        for x in range(s):
            if em_px[x, y] > 0:
                r, g, b, a = px[x, y]
                px[x, y] = (r, g, b, max(0, a - em_px[x, y]))

    # Subtle inner shadow on the kidney
    shadow = kidney_layer.filter(ImageFilter.GaussianBlur(radius=int(s * 0.01)))

    # Soft drop shadow under the kidney
    drop = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    dd = ImageDraw.Draw(drop)
    offset = int(s * 0.015)
    body_alpha = kidney_layer.split()[3]
    drop_mask = body_alpha.filter(ImageFilter.GaussianBlur(radius=int(s * 0.02)))
    drop = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    drop.paste((0, 0, 0, 70), (offset, offset), drop_mask)

    # Composite: bg -> drop shadow -> kidney
    composed = img.copy()
    composed.alpha_composite(drop)
    composed.alpha_composite(shadow)

    # Downsample with high quality
    final = composed.resize((size, size), Image.LANCZOS)
    return final

for size in [180, 192, 512]:
    icon = make_icon(size)
    icon.save(f"icon-{size}.png", "PNG", optimize=True)
    print(f"Wrote icon-{size}.png")

# Also generate a 1024 for App Store / future use
icon_1024 = make_icon(1024)
icon_1024.save("icon-1024.png", "PNG", optimize=True)
print("Wrote icon-1024.png")
