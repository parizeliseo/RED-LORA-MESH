# -*- coding: utf-8 -*-
import base64, io, re, sys, asyncio, json
from PIL import Image
from playwright.async_api import async_playwright
from content import CH
FIG_N = [0]
def img64(name):
    import os
    ruta = next(f"img/{name}{e}" for e in (".png", ".jpg") if os.path.exists(f"img/{name}{e}"))
    im = Image.open(ruta).convert("RGB")
    b = io.BytesIO(); im.save(b, "JPEG", quality=84, optimize=True)
    return "data:image/jpeg;base64," + base64.b64encode(b.getvalue()).decode()
def render_block(bl):
    k = bl[0]
    if k == "p": return f"<p>{bl[1]}</p>"
    if k == "h3": return f"<h3>{bl[1]}</h3>"
    if k == "ul": return "<ul>" + "".join(f"<li>{x}</li>" for x in bl[1]) + "</ul>"
    if k == "steps": return "<ol class='steps'>" + "".join(f"<li><span>{x}</span></li>" for x in bl[1]) + "</ol>"
    if k in ("tip", "warn", "note"):
        lab = {"tip": "Consejo", "warn": "Importante", "note": "Nota"}[k]
        return f"<div class='box {k}'><div class='bt'>{lab}</div><div>{bl[1]}</div></div>"
    if k == "table":
        head = "".join(f"<th>{h}</th>" for h in bl[1]); rows = "".join("<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>" for r in bl[2])
        return f"<table class='{'w4' if len(bl[1])>=4 else ''}'><thead><tr>{head}</tr></thead><tbody>{rows}</tbody></table>"
    if k == "code": return f"<pre class='code'>{bl[1]}</pre>"
    if k == "fig":
        FIG_N[0] += 1
        leg = ("<ol class='leg'>" + "".join(f"<li><span>{x}</span></li>" for x in bl[3]) + "</ol>") if bl[3] else ""
        return f"<figure><img src='{img64(bl[1])}'><figcaption><b>Figura {FIG_N[0]}.</b> {bl[2]}</figcaption></figure>{leg}"
    raise ValueError(k)
def build(pages=None):
    FIG_N[0] = 0
    toc = "".join(f"<li><a href='#c{i+1}'><span class='n'>{i+1}</span><span class='t'>{t}</span><span class='dots'></span><span class='pg'>{(pages or {}).get(i+1,'')}</span></a></li>" for i, (t, _) in enumerate(CH))
    body = ""
    for i, (t, blocks) in enumerate(CH):
        body += f"<section class='chap' id='c{i+1}'><div class='chead'><span class='cn'>{i+1}</span><h2>{t}</h2></div>" + "".join(render_block(b) for b in blocks) + "</section>"
    css = open("manual.css", encoding="utf-8").read()
    return f"""<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Instructivo OPEN SOURCE PARIZ</title><style>{css}</style></head><body>
<section class="cover"><div class="cv-top"><div class="logo">▲</div><div><b>OPEN SOURCE PARIZ</b><br><small>Sistema LoRa Mesh</small></div></div>
<div class="cv-mid"><div class="kicker">INSTRUCTIVO DE USUARIO</div><h1>Portal de comunicaciones<br>LoRa Mesh</h1><p>Guía completa, paso a paso, con capturas de pantalla: conexión del nodo, mensajes, emergencias, nodos y mapa, MQTT, sonidos y configuración.</p></div>
<div class="cv-bot"><div><b>Versión</b><br>1.0</div><div><b>Fecha</b><br>19 de octubre de 2026</div><div><b>Equipo de referencia</b><br>Heltec V3 · firmware 2.8.1</div></div></section>
<section class="tocp"><h2 class="toch">Contenido</h2><ol class="toc">{toc}</ol>
<div class="howto"><b>Cómo leer este instructivo</b><p>Los números rojos de las capturas se explican en la lista numerada que está debajo de cada figura. Los recuadros <span class="tag tip">Consejo</span> <span class="tag note">Nota</span> y <span class="tag warn">Importante</span> destacan información que conviene no pasar por alto.</p></div></section>
{body}</body></html>"""
async def render(html, out):
    async with async_playwright() as p:
        b = await p.chromium.launch(); pg = await b.new_page()
        await pg.set_content(html, wait_until="load"); await pg.wait_for_timeout(500)
        foot = """<div style="width:100%;font:8.5px Arial;color:#6b7280;padding:0 18mm;display:flex;justify-content:space-between"><span>OPEN SOURCE PARIZ · Instructivo de usuario</span><span>Página <span class="pageNumber"></span> de <span class="totalPages"></span></span></div>"""
        await pg.pdf(path=out, format="A4", print_background=True, display_header_footer=True, header_template="<div></div>", footer_template=foot, margin={"top":"0","bottom":"0","left":"0","right":"0"}, prefer_css_page_size=True)
        await b.close()
def pages_of(pdf):
    from pypdf import PdfReader
    r = PdfReader(pdf); res = {}; last = 1
    for i, (t, _) in enumerate(CH):
        for n, pg in enumerate(r.pages):
            if n <= last: continue  # el índice puede ocupar dos hojas: se busca después del capítulo anterior
            tx = pg.extract_text() or ""
            if re.search(rf"(^|\n)\s*{i+1}\s*\n?\s*{re.escape(t)}", tx):
                res[i+1] = n + 1; last = n; break
    return res
if __name__ == "__main__":
    out = "manual.pdf"
    asyncio.run(render(build(), out)); pg = pages_of(out); print(pg)
    asyncio.run(render(build(pg), out)); pg2 = pages_of(out); print(pg2 == pg)
    # portada sin pie de página: se vuelve a generar sola y reemplaza la primera hoja
    full = build(pg); cover = re.sub(r'<section class="tocp">.*', '</body></html>', full, flags=re.S)
    async def cv():
        async with async_playwright() as p:
            b = await p.chromium.launch(); pg_ = await b.new_page(); await pg_.set_content(cover, wait_until="load")
            await pg_.pdf(path="cover.pdf", format="A4", print_background=True, margin={"top":"0","bottom":"0","left":"0","right":"0"}, prefer_css_page_size=True); await b.close()
    asyncio.run(cv())
    from pypdf import PdfReader, PdfWriter
    r = PdfReader(out); c = PdfReader("cover.pdf"); w = PdfWriter(); w.add_page(c.pages[0])
    for i in range(1, len(r.pages)): w.add_page(r.pages[i])
    w.add_metadata({"/Title": "Instructivo de usuario - OPEN SOURCE PARIZ", "/Author": "OPEN SOURCE PARIZ"})
    w.write("instructivo.pdf"); print(len(w.pages))
