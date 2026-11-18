# 💰 El Gran Millón

Juego de preguntas **cooperativo y en línea** para hasta 4 amigos. El equipo sube una escalera de 10, 15 o 20 preguntas de dificultad creciente, con 4 opciones cada una, hasta el premio mayor de $1,000,000. Tiene gráficos 3D low-poly, música generada en el navegador y se juega sin registro, como skribbl.io: pones tu nombre, eliges tu avatar y entras.

## Cómo se juega

- **¡Jugar!** te mete en una sala pública abierta. Si no hay ninguna, se crea una nueva.
- **Crear sala privada** te da un código de 5 letras y un link para invitar.
- Todos votan cada respuesta y **gana la mayoría**. Si hay empate, gana la opción que llegó primero a ese número de votos.
- Cuando todos votaron empieza la cuenta de «respuesta final». Tocar otra vez tu opción la fija al instante.
- El equipo también puede votar **🏳️ Plantarse** para llevarse lo ganado hasta ese momento.
- **Puntos seguros 🛡️**: si el equipo falla, se lleva el premio del último punto seguro que pasó.

### Roles y comodines

Cada jugador elige un rol en la sala y solo él puede usar su comodín. Si son menos de 4, los comodines sin dueño se reparten entre el equipo.

| Rol | Comodín |
|---|---|
| 🦉 El Sabio | Mitad: elimina dos respuestas incorrectas |
| 📱 La Influencer | Encuesta: muestra cómo votó el público |
| 🕶️ El Hacker | Cambiar pregunta |
| 🍀 El Suertudo | Doble intento: si fallan, tienen otra oportunidad |
| 📚 La Profesora (desbloqueable) | Pista experta con porcentaje de seguridad |
| ⏱️ El Cronometrista (desbloqueable) | +30 segundos |

### Ajustes de la sala

Temas, largo de la escalera, tiempo por pregunta, dificultad, puntos seguros, estilo visual, sala pública o privada y **preguntas personalizadas** (una por línea: `Pregunta | Correcta | Incorrecta | Incorrecta | Incorrecta | dificultad`).

### Desbloqueos

Hay 4 estilos visuales: **Gala neón** viene de serie; **Juguetería**, **Arcade synthwave** y **Torre del tesoro** se desbloquean jugando. También se desbloquean sombreros y roles. El anfitrión elige el estilo de la partida y todos la ven así.

## Banco de preguntas

`data/q/*.json` reúne 1020 preguntas en español en 12 temas, con 85 por tema repartidas en 5 niveles de dificultad. El juego recuerda en cada navegador qué preguntas ya viste y prioriza las que el equipo no ha visto.

Para validar después de editar:

```bash
node tools/validate-questions.mjs
```

Formato: `[dificultad 1-5, "¿Pregunta?", "Correcta", "Incorrecta 1", "Incorrecta 2", "Incorrecta 3"]`. Agrega preguntas solo al final de cada archivo, porque su posición es su identificador.

## Probar en local

```bash
node tools/serve.mjs 5173
```

Abre `http://localhost:5173`. Para probar el multijugador, abre varias pestañas: cada una cuenta como un jugador distinto.

## Arquitectura

- **Sin compilación**: HTML, CSS y módulos ES. three.js y supabase-js se cargan desde jsDelivr con versión fija.
- **Supabase Realtime**: cada sala es un canal con presencia y broadcast. El navegador del anfitrión ejecuta el motor de la partida (`js/engine.js`) y envía el estado a los demás. Si el anfitrión se va, otro jugador toma el control con el último estado.
- **Base de datos** (con RLS): `hall_of_fame` (cualquiera lee e inserta registros validados) y `question_reports` (solo inserción).
- `js/scene.js`: escenario 3D y los 4 estilos · `js/avatar.js`: avatares low-poly · `js/audio.js`: música y efectos generados con WebAudio · `js/main.js`: interfaz.

## Publicar

El sitio es estático: GitHub Pages lo sirve desde la raíz de la rama `main`. La clave de Supabase que aparece en `js/config.js` es la **publicable**, pensada para ir en el navegador; las políticas RLS protegen los datos.

> Nota: en el plan gratis, Supabase pausa el proyecto tras 7 días sin actividad. Si el multijugador deja de funcionar, reactívalo desde el panel de Supabase.

*El Gran Millón es un juego original inspirado en el género de los concursos de preguntas. No está afiliado a ningún programa de televisión.*
