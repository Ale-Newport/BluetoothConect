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
| **Age Rating** — ¿mensajes entre usuarios? | **Yes**. Todo lo demás (violencia, apuestas, web…) **No**. Saldrá 13+ y es lo correcto. |

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

1. App Store Connect → **TestFlight** → **Internal Testing** → **+** → añade a un amigo.
2. Tu amigo instala la app **TestFlight** y acepta la invitación. No hace falta
   conectar su iPhone a tu Mac.
3. Probad: emparejar, chatear, enviar una foto, jugar.
4. **Muy importante — probad también sin Wi-Fi:** en los dos iPhones, modo avión
   y después vuelve a activar solo el **Bluetooth**. Conectad y mandad un
   mensaje. Es lo único que no se puede probar en el Mac (los simuladores no
   tienen Bluetooth), así que es la primera vez que se comprobará de verdad.
5. Probad también una **nota de voz** y que llegue la **notificación** con la
   app del otro en segundo plano. Están hechas y tienen tests, pero tampoco se
   pueden probar bien en un simulador.

Si algo de esto falla, **no envíes a revisión todavía**: cuéntamelo y lo
arreglamos primero.

---

## 9. Envíala a revisión

En la página de la versión:

1. Pega las **App Review Notes** de `docs/APP_STORE_LISTING.md`. **Es el campo
   más importante**: explica al revisor que hacen falta dos dispositivos.
2. Adjunta un vídeo corto grabando dos móviles conectándose.
3. Marca **"Manually release this version"** (así tú decides cuándo sale).
4. **Submit for Review**.

Tarda de 1 a 3 días. Si la rechazan, **no es un fracaso**: lee el número de la
norma, corrige y responde en el Resolution Center. Lo normal la primera vez es
un par de idas y vueltas.

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
