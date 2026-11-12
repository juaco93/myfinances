# Finanzas

App personal de finanzas: patrimonio en pesos y dólares MEP, ingresos y gastos, inversiones en InvertirOnline (IOL) y gastos de una obra leídos de una planilla de Google. Un agente externo (bot) carga movimientos y saldos por una API con token.

- **Resumen:** patrimonio con su evolución, ingresos, gastos y ahorro del período, a dónde va la plata (Sankey), cuentas y gastos por categoría.
- **Movimientos:** todos los movimientos agrupados por día, con filtros y edición de categoría.
- **Inversiones:** cartera de IOL en vivo, composición, comparación con S&P 500 y Merval en dólares, rendimiento mensual y tenencias.
- **Configuración:** credenciales de IOL, planilla de la obra, tema claro u oscuro, acceso del bot.

Node 22 (usa `node:sqlite`), Express y Chart.js. Sin build: los archivos de `public/` se sirven tal cual.

## Puesta en marcha

```bash
npm ci
cp .env.example .env      # completar valores
node lib/auth.js 'una-contraseña'   # pegar el resultado en FINANZAS_LOGIN_HASH
npm start                 # http://127.0.0.1:9595
```

Los datos viven en `data/` (SQLite `data/finanzas.db`, snapshots diarios) y `portfolio.json`. Ninguno se versiona.

## Configuración (`.env`)

| Variable | Para qué |
|---|---|
| `HOST`, `PORT` | Dónde escucha (por defecto `127.0.0.1:9595`) |
| `FINANZAS_LOGIN_USER`, `FINANZAS_LOGIN_HASH`, `FINANZAS_SESSION_SECRET` | Login de la interfaz web |
| `FINANZAS_API_TOKEN` | Token del bot para `/api/v1` |
| `FINANZAS_PUBLIC_URL` | URL pública que aparece en la guía del bot |
| `IOL_API_ENABLED`, `IOL_USE_REAL_PORTFOLIO`, `IOL_USERNAME`, `IOL_PASSWORD` | Cartera en vivo desde IOL. Usuario y contraseña también se cargan desde Configuración, que los prueba contra IOL antes de guardarlos |
| `OBRA_SHEET_ID`, `OBRA_SHEET_RANGE`, `GOOGLE_SERVICE_ACCOUNT_FILE` | Planilla de gastos de la obra (opcional) |
| `OBRA_LABEL`, `OBRA_CATEGORY`, `OBRA_LINK_CATEGORIES` | Nombre de la obra, categoría de sus gastos y categorías donde buscar pagos repetidos |

Las reglas de categorización que nombran personas (proveedores, cuentas propias) no van en el código: se ponen en `data/rules.local.json` y solo se usan para poblar una base vacía.

## Login

La interfaz web y `/api/finance` piden sesión (un solo usuario). `/api/v1` usa el token del bot y no necesita login.

- Cambiar la contraseña: `node lib/auth.js 'nueva'`, pegar el resultado en `FINANZAS_LOGIN_HASH` y reiniciar.
- Cerrar todas las sesiones: cambiar `FINANZAS_SESSION_SECRET` (`openssl rand -hex 32`) y reiniciar.
- Cinco intentos fallidos bloquean esa IP por 15 minutos. La sesión dura 30 días.

## Planilla de la obra

`lib/obra-sheet.js` lee la planilla con una cuenta de servicio de Google (solo lectura) al arrancar y cada 30 minutos, o desde Configuración con "Sincronizar ahora". Columnas esperadas: Fecha (dd/mm/aaaa), Descripción, Categoría, Subcategoría, Gasto ARS, Gasto USD, Comentarios, ID de operación de MercadoPago. Las filas sin fecha (totales) se ignoran.

- Lo gastado en la obra también es patrimonio: el total de Resumen suma la obra a costo (cada pago al dólar MEP de su día). "Solo cuentas" la deja afuera. `OBRA_ASSET_LABEL` le cambia el nombre.
- La planilla manda: filas nuevas se agregan, las editadas se actualizan y las borradas se eliminan. Si de golpe vuelve menos de la mitad de las filas guardadas, no se borra nada.
- Un pago que también aparece en otra cuenta (la transferencia de MercadoPago al proveedor) se vincula a su fila por número de operación, o por moneda, monto y fecha con hasta 3 días de diferencia. Pasa a "Pago de obra" y no se cuenta dos veces.

## API del bot

`/api/v1` con `Authorization: Bearer $FINANZAS_API_TOKEN`. Instrucciones en `/api/v1/guide` y especificación en `/api/v1/openapi.json`.

## Tests

```bash
npm test
```

## Despliegue

Cada push a `main` se despliega solo con el CI/CD del servidor: descarga el commit, corre `npm ci` y los tests, reinicia la app y verifica `/login`. Si algo falla vuelve a la versión anterior. `.env`, `data/` y `portfolio.json` quedan intactos.
