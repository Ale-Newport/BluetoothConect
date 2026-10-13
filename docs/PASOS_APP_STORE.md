# Subir AirLink a la App Store — los pasos que te quedan

Todo lo que se podía hacer sin tu cuenta de Apple ya está hecho (la lista está
al final). Lo que queda necesita **tu identidad, tu dinero o tu decisión**, así
que no se puede hacer por ti.

Son 9 pasos. Hazlos en orden: cada uno depende del anterior.

---

## 1. Paga la cuenta de desarrollador de Apple — hazlo hoy

**Cuesta 99 $ al año y es obligatorio.** Con tu Apple ID gratuito no se puede
publicar nada en la App Store.

1. Instala la app **Apple Developer** en tu iPhone (es gratis).
2. Ábrela → **Account** → **Enroll**.
3. Elige **Individual** (no "Organization").
4. Verifica tu identidad con tu DNI y Face ID, y paga.

La aprobación puede tardar desde minutos hasta una semana. **Por eso va
primero**: todo lo demás espera a esto.

> Bonus: con la cuenta de pago dejarás de tener que reinstalar la app en tu
> iPhone cada 7 días.

---

## 2. Pon tu email de contacto (1 comando)

Apple exige un email de soporte público. Te recomiendo crear uno nuevo solo para
esto (por ejemplo en Gmail: `airlink.soporte@gmail.com`) en vez de usar el
personal, porque será público.

Después, en la carpeta del proyecto:

```bash
./scripts/set-contact.sh "Tu Nombre" tu-email@ejemplo.com tu-usuario-de-github
```

Esto rellena tu nombre y email en la app, en la web de soporte y en la política
de privacidad a la vez, y comprueba que no quede ningún hueco.

> Si no tienes cuenta de GitHub, créala gratis en github.com antes de este paso.

---

## 3. Publica la web de soporte (5 minutos)

La web ya está escrita en la carpeta `support-site/`. Solo hay que subirla:

1. En github.com → **New repository** → nombre: `airlink-support` → **Public** → **Create**.
2. **Add file → Upload files** → arrastra los 4 archivos de la carpeta
   `support-site/` → **Commit changes**.
3. **Settings → Pages** → Source: **Deploy from a branch** → Branch: **main** →
   carpeta **/ (root)** → **Save**.

En un par de minutos estará en `https://tu-usuario.github.io/airlink-support/`.
Ábrela en el móvil para comprobar que se ve.

---

## 4. Crea la app en App Store Connect

En [appstoreconnect.apple.com](https://appstoreconnect.apple.com):

1. Primero: **Business → Agreements** → acepta el acuerdo. Si no, no te dejará subir nada.
2. **Apps → +** → **New App**:
   - Platform: **iOS**
   - Name: **AirLink** (si está cogido, prueba `AirLink Nearby`)
   - Primary language: **Spanish** o **English**
   - Bundle ID: **com.alejandronewport.airlink**
   - SKU: `airlink-1` (lo que quieras, nadie lo ve)

> ⚠️ El Bundle ID **no se puede cambiar nunca** después de este paso.

---

## 5. Sube la app

En el Mac, en la carpeta del proyecto:

```bash
./scripts/archive-ios.sh --upload
```

Crea el archivo firmado para la App Store y lo sube a Apple, todo de una vez
(tarda unos minutos sin mostrar nada). Usa la cuenta de Apple que tienes en
**Xcode → Settings → Accounts**, así que no te pide ninguna contraseña. Si el
Mac pide acceso a la llave "Apple Distribution", pon la contraseña de tu Mac y
pulsa **Permitir siempre**.

> Otras formas, si prefieres: en Xcode, **Window → Organizer → Archives** → el
> AirLink más reciente → **Distribute App → App Store Connect → Distribute**; o
> la app gratuita **Transporter** (Mac App Store), arrastrando el archivo
> `.ipa` que indica el script.

Tarda de 10 minutos a 2 horas en "procesarse". Si te llega un email de rechazo a
los pocos minutos, **no es una persona**: es un comprobador automático que te
dice exactamente qué falla.

---

## 6. Rellena la ficha de la app

Todo el texto está listo para copiar y pegar en **`docs/APP_STORE_LISTING.md`**:
nombre, subtítulo, descripción, palabras clave y notas para el revisor.

- **Capturas:** ya están hechas, 5 imágenes en dos tamaños. Si la casilla es
  **Pantalla de 6,5"** (pide 1284 × 2778), usa las de
  `docs/app-store-screenshots/6.5-inch/`; si es **6,9"**, las de
  `docs/app-store-screenshots/`. Con un tamaño basta. Arrástralas **en orden,
  del 1 al 5**: las dos primeras son las que la gente ve en los resultados de
  búsqueda.
- **Support URL** y **Privacy Policy URL:** las que te dio el paso 2.
- **Price:** Free.

---

## 7. Responde las tres preguntas legales

Son declaraciones oficiales, así que contéstalas tal cual:

| Pregunta | Respuesta |
|---|---|
| **App Privacy** — ¿recoges datos? | **"No, we do not collect data from this app."** Luego pulsa **Publish**. |
| **Encryption** — sale en cada build como **"Missing Compliance"** (TestFlight → la build → **Manage**) | Tipo de algoritmo: **"Standard encryption algorithms instead of, or in addition to, using or accessing the encryption within Apple's operating system"**. ¿Disponible en Francia? **No**. |
| **Age Rating** — 7 pasos | Contenido (violencia, sexo, apuestas, medicina…): **Ninguna**. Capacidades: **Mensajería y chat: Sí**, contenido generado por usuarios: **Sí**, redes sociales: **No**, acceso web: **No**, publicidad: **No**. Apple calcula **4+**; súbela a mano a **13+** con "Reemplazar por una clasificación más alta". **Nunca "Apta para menores"**, que es la categoría infantil y prohíbe el chat abierto. |

> Sobre el cifrado: la app cifra los mensajes con algoritmos estándar (no
> los del propio iPhone), así que **no elijas "None"** para que deje de
> preguntar: es una declaración oficial. Para Francia, Apple exige antes una
> declaración de cifrado francesa; por eso lo más sencillo es empezar **sin
> Francia**: en **Pricing and Availability** quítala de la lista de países.
> Se puede añadir más adelante. Si las preguntas que ves no coinciden con
> estas, mándame una captura antes de responder. Detalles en
> `docs/APP_STORE.md`, parte 3.

---

## 8. Pruébala con TestFlight en dos iPhones

AirLink necesita **dos móviles** para funcionar, y esta es la única forma fácil
de probarla en dos teléfonos reales antes de publicarla.

> **Los dos iPhones necesitan iOS 18 o superior.** La app no arranca por debajo
> (ver `STABILITY_AUDIT.md`, apartado 3f). Si un amigo tiene iOS 17, TestFlight
> no le dejará instalarla: no es un fallo, es el mínimo.

1. App Store Connect → **TestFlight** → **Internal Testing** → **+** → añade a un amigo.
2. Tu amigo instala la app **TestFlight** y acepta la invitación. No hace falta
   conectar su iPhone a tu Mac.
3. Probad con **Wi-Fi**: emparejar (los seis dígitos), chatear, jugar y, con la
   barra de mensaje: **+** → una foto de la galería y un archivo; el botón de la
   **cámara** (la primera vez iOS pide permiso de cámara: acéptalo) para hacer
   una foto y enviarla; el **micrófono** para una nota de voz. Al escribir
   cualquier cosa, la cámara y el micrófono se cambian por el botón de enviar.
4. **Muy importante — probad también sin Wi-Fi:** en los dos iPhones, modo avión
   y después vuelve a activar solo el **Bluetooth**. Cada uno debe ver al otro en
   "Other devices" en unos segundos; conectad y mandad un mensaje y una foto.
   Es lo único que no se puede probar en el Mac (los simuladores no tienen
   Bluetooth). Los textos van en menos de un segundo; **las fotos y los archivos
   van mucho más lentos por Bluetooth** (en la única medida que existe, 64 KB
   tardaron 154 s). No es un fallo nuevo, pero no prometas fotos rápidas sin Wi-Fi.

   > **Si solo tienes un iPhone:** un simulador **no sirve** para esto. No tiene
   > radio Bluetooth, así que un iPhone sin Wi-Fi no tiene ningún camino hasta
   > él (no es un fallo de la app). Necesitas otro aparato con Bluetooth: un
   > iPad o el iPhone de un amigo con iOS 18, instalando AirLink por TestFlight.
   > Mientras tanto, `./scripts/ble-mac-peer.sh` usa el Bluetooth del propio Mac
   > como segundo aparato y comprueba la parte que decide si dos móviles se
   > encuentran y abren un enlace (no llega a emparejar). Cómo se usa, en
   > `docs/TESTING.md`.
5. Probad la **notificación** con la app del otro en segundo plano.

Si algo de esto falla, **no envíes a revisión todavía**: cuéntamelo y lo
arreglamos primero.

---

## 9. Envíala a revisión

Apple ya contestó a un primer envío (ver el recuadro de abajo). Lo que hay que
hacer ahora es **responderles y reenviar**, no empezar de cero.

0. **Antes de nada, sube la web de soporte actualizada.** La política de
   privacidad ahora dice que la cámara también sirve para hacer una foto dentro
   de un chat, y tiene que coincidir con lo que hace la app. En el repositorio
   `airlink-support` de GitHub (paso 3): **Add file → Upload files** → arrastra
   `support-site/privacy.html` y `support-site/index.html` (sustituyen a los
   anteriores) → **Commit changes**. Espera un par de minutos y abre la página de
   privacidad en el móvil: debe poner "Last updated: 13 October 2026" y hablar
   del botón de cámara.
1. **Graba el vídeo en tu iPhone de verdad** (el de simuladores no vale:
   piden un iPhone físico con el último iOS). **Con un solo iPhone te basta**:
   el compañero puede ser el simulador "Lucas" en el Mac, en la misma Wi-Fi,
   como acabas de probar. Lo que Apple exige es que la **grabación** sea de un
   iPhone físico, no que el otro lado también lo sea. Empieza a grabar la pantalla
   **antes** de abrir la app y haz, en este orden: abrir AirLink desde la
   pantalla de inicio → primera vez (nombre, permisos) → el otro móvil aparece en
   "Other devices" → **Connect** → los **mismos seis dígitos** en los dos →
   "They match" en ambos → un mensaje, una foto con el botón **+** o con la
   **cámara**, y una **nota de voz** → una
   partida en **Play** → y **al final del todo**, **mantén pulsado un mensaje
   recibido → "Report and block"**. Va el último porque bloquea a la otra
   persona y borra la conversación: después ya no se puede jugar ni chatear (se
   deshace en **You → Friends → Unblock**). Con 2–3 minutos basta.
2. Pega el texto de `docs/APP_STORE_LISTING.md` (sección *The Guideline 2.1
   information request*) en **dos sitios**: la respuesta en el Resolution Center
   **y** App Review Information → **Notes**. Adjunta el vídeo a la respuesta.
   **Si ya habías pegado el texto antes, vuelve a pegarlo:** cambió la frase de
   los permisos (la cámara ya no es solo para el QR) y la descripción de la
   barra del chat. Borra lo anterior y pega todo de nuevo.
3. Elige la **build más reciente** en la sección Compilación de la versión.
   Xcode pone él mismo el número de build al subir (el proyecto dice 8 ahora, pero
   puede que salga otra): elige siempre **la de número más alto**, y mira que la
   hora de subida sea la de hoy.
4. Comprueba que **Pricing and Availability** sigue sin Francia y que la
   clasificación por edades sigue en **13+**: el texto de respuesta lo afirma.
5. Marca **"Manually release this version"** (así tú decides cuándo sale).
6. **Submit for Review** / "Volver a enviar a revisión de apps".

Tarda de 1 a 3 días. Si la rechazan, **no es un fracaso**: lee el número de la
norma, corrige y responde en el Resolution Center. Lo normal la primera vez es
un par de idas y vueltas.

> **Lo que pasó en el primer envío:** Apple contestó con *"Guideline 2.1 –
> Information Needed – New App Submission"*. No encontraron ningún fallo: es el
> cuestionario que le mandan a las cuentas nuevas. Piden seis respuestas y un
> **vídeo grabado en un iPhone de verdad**. El texto de la respuesta, ya
> escrito, está en `docs/APP_STORE_LISTING.md`, al final.

---

## Lo que ya está hecho por ti

- **Errores arreglados:** el emparejamiento que decía "Couldn't connect" aunque
  había funcionado; las fotos del chat que nunca llegaban al otro móvil; bloquear
  a un desconocido que no hacía nada; el aviso de Bluetooth que mentía; el texto
  que se montaba encima de la hora al hacer scroll.
- **Todo lo que rechazaría Apple automáticamente:** el icono (tenía
  transparencia), permisos que no se usaban, versión, Bundle ID, firma,
  declaración de cifrado.
- **Funciones nuevas:** fotos y notas de voz en el chat, avisos de mensajes no
  leídos en la barra de abajo, notificaciones, reportar y bloquear, colores por
  sección.
- **Documentos:** web de soporte, política de privacidad, textos de la ficha,
  notas para el revisor, capturas de pantalla.
- **Scripts:** `archive-ios.sh` (crear el archivo para la App Store) y
  `set-contact.sh` (rellenar tus datos de una vez).

La guía completa y detallada, con el porqué de cada cosa, está en
`docs/APP_STORE.md`.
