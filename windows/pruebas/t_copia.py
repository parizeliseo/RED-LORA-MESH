import os, tempfile
import asyncio, json, os
from playwright.async_api import async_playwright
P = "file://" + os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "portal", "dist", "portal-meshtastic.html"))
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        # 1) "PC vieja": con datos
        ctx1 = await b.new_context(accept_downloads=True); pg = await ctx1.new_page()
        errs=[]; pg.on("pageerror", lambda e: errs.append(str(e)[:150]))
        await pg.route("https://**/*", lambda r: r.abort()); await pg.route("wss://**/*", lambda r: r.abort())
        await pg.goto(P); await pg.wait_for_timeout(1200)
        await pg.evaluate("""()=>{
          localStorage.setItem('meshportal:123:msgs', JSON.stringify([{id:1,text:'hola'},{id:2,text:'árbol caído km 12'}]));
          localStorage.setItem('meshportal:123:nodes', JSON.stringify([{num:1},{num:2},{num:3}]));
          localStorage.setItem('meshportal:favs', JSON.stringify([5,6]));
          localStorage.setItem('meshportal:guardia', JSON.stringify({unit:'Puesto Chapelco'}));
          localStorage.setItem('otra-cosa', 'no debe viajar');
        }""")
        await pg.evaluate("()=>window.__ui.setView('settings','portal.copia')")
        await pg.wait_for_timeout(800)
        print("pantalla:", (await pg.evaluate("()=>document.querySelector('#main').innerText")).split("\n")[0:4])
        async with pg.expect_download() as d:
            await pg.get_by_role("button", name="Guardar copia", exact=True).click()
        dl = await d.value; ruta = os.path.join(tempfile.gettempdir(), "copia.json"); await dl.save_as(ruta)
        c = json.load(open(ruta)); print("archivo:", dl.suggested_filename, "| claves:", sorted(c["datos"].keys()), "| origen:", c["origen"])
        # 2) "PC nueva": vacía; restaurar
        ctx2 = await b.new_context(); pg2 = await ctx2.new_page()
        await pg2.route("https://**/*", lambda r: r.abort()); await pg2.route("wss://**/*", lambda r: r.abort())
        await pg2.goto(P); await pg2.wait_for_timeout(1200)
        await pg2.evaluate("()=>{ localStorage.setItem('meshportal:viejo', 'se tiene que borrar'); window.confirm=()=>true; }")
        await pg2.evaluate("()=>window.__ui.setView('settings','portal.copia')"); await pg2.wait_for_timeout(600)
        await pg2.set_input_files("input[type=file][accept*=json]", ruta)
        await pg2.wait_for_timeout(2500)   # restaura y recarga
        r = await pg2.evaluate("""()=>({ msgs: JSON.parse(localStorage.getItem('meshportal:123:msgs')||'[]').length,
             texto: (JSON.parse(localStorage.getItem('meshportal:123:msgs')||'[]')[1]||{}).text,
             favs: localStorage.getItem('meshportal:favs'), viejo: localStorage.getItem('meshportal:viejo'),
             ajeno: localStorage.getItem('otra-cosa') })""")
        print("restaurado:", r)
        # 3) un archivo cualquiera no debe romper nada
        open(os.path.join(tempfile.gettempdir(), "malo.json"),"w").write('{"hola":1}')
        await pg2.evaluate("()=>window.__ui.setView('settings','portal.copia')"); await pg2.wait_for_timeout(500)
        await pg2.set_input_files("input[type=file][accept*=json]", os.path.join(tempfile.gettempdir(), "malo.json")); await pg2.wait_for_timeout(600)
        print("archivo equivocado →", await pg2.evaluate("()=>[...document.querySelectorAll('#toasts *')].map(e=>e.innerText).filter(Boolean).pop()"))
        print("errores:", errs or "ninguno")
        await b.close()
asyncio.run(main())
