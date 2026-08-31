const browserAPI = typeof browser !== 'undefined' ? browser : chrome;
const SECRET_TOKEN = 'mi-proyecto-middleware-2024-epn'; // mismo valor que en .env

const SITIOS_SOPORTADOS = [
  'https://chatgpt.com/*',
  'https://claude.ai/*',
  'https://gemini.google.com/*'
];

const CONTENT_SCRIPT_ID = 'content-main';

// Registra content.js en MAIN world.
// Si había una versión anterior registrada dinámicamente, la reemplazamos
// para que siempre use exactamente la lista actual de sitios soportados.
async function registrarContentPrincipal() {
  try {
    const registrados = await browserAPI.scripting.getRegisteredContentScripts({
      ids: [CONTENT_SCRIPT_ID]
    });

    if (registrados.length > 0) {
      await browserAPI.scripting.unregisterContentScripts({
        ids: [CONTENT_SCRIPT_ID]
      });
    }

    await browserAPI.scripting.registerContentScripts([{
      id: CONTENT_SCRIPT_ID,
      matches: SITIOS_SOPORTADOS,
      js: ['content.js'],
      runAt: 'document_start',
      world: 'MAIN'
    }]);
  } catch (error) {
    console.error('[Middleware] No se pudo registrar content.js:', error);
  }
}

browserAPI.runtime.onInstalled.addListener(() => {
  registrarContentPrincipal();
});

// ============================================================
// Estado de la extensión (activada/desactivada)
// ============================================================
async function obtenerEstado() {
  const { activo } = await browserAPI.storage.local.get({ activo: true });
  return activo;
}

// Cuando el popup cambia el estado, avisamos a todas las pestañas
// de los sitios soportados para que content.js reaccione en vivo.
browserAPI.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !('activo' in changes)) return;

  const activo = changes.activo.newValue;

  browserAPI.tabs.query({ url: SITIOS_SOPORTADOS }, (tabs) => {
    for (const tab of tabs) {
      browserAPI.tabs
        .sendMessage(tab.id, { type: 'ESTADO_CAMBIADO', activo })
        .catch(() => {});
    }
  });
});

// ============================================================
// Mensajería con content.js (vía bridge)
// ============================================================
browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'OBTENER_ESTADO') {
    obtenerEstado().then((activo) => {
      sendResponse({ ok: true, activo });
    });
    return true;
  }

  if (message.type !== 'CONVERTIR_ARCHIVO') return;

  const { base64, nombre, mimeType } = message;

  if (base64.length > 27 * 1024 * 1024) {
    sendResponse({ ok: false, error: 'Archivo demasiado grande' });
    return true;
  }

  const byteCharacters = atob(base64);
  const byteNumbers = new Uint8Array(byteCharacters.length);

  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }

  const blob = new Blob([byteNumbers], { type: mimeType });
  const formData = new FormData();
  formData.append('archivo', blob, nombre);

  fetch('http://localhost:5000/convertir', {
    method: 'POST',
    headers: {
      'X-Token': SECRET_TOKEN
    },
    body: formData
  })
    .then(async (res) => {
      const texto = await res.text();

      try {
        const data = JSON.parse(texto);

        if (data.ok) {
          sendResponse({ ok: true, markdown: data.markdown });
        } else {
          sendResponse({ ok: false, error: data.error });
        }
      } catch {
        sendResponse({
          ok: false,
          error: 'Respuesta no es JSON: ' + texto
        });
      }
    })
    .catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });

  return true;
});
