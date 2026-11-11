'use strict';

// Documentation served to the bot at /api/v1/guide (markdown) and /api/v1/openapi.json.

function createDocs({ baseUrl }) {
  const api = `${baseUrl.replace(/\/$/, '')}/api/v1`;

  function guide() {
    return `# API de Finanzas: guía para el bot

Base URL: \`${api}\`
Auth: header \`Authorization: Bearer <FINANZAS_API_TOKEN>\` en todas las rutas salvo \`/guide\` y \`/openapi.json\`.
Formato: JSON. Fechas \`YYYY-MM-DD\` (hora de Argentina). Montos como número JSON con punto decimal, sin separador de miles (\`-15300.5\`, no \`"15.300,50"\`).
Spec completa: \`${api}/openapi.json\`.

## Qué mantener actualizado

| Cuenta (account_id) | Moneda | Qué cargar |
|---|---|---|
| \`wallbit\` | USD | Saldo total (cash + inversiones) y movimientos de entrada/salida de plata |
| \`mercadopago-ars\` | ARS | Saldo disponible (incluido lo que rinde) y movimientos |
| \`mercadopago-usd\` | USD | Idem, si hay dólares en MP |
| \`personal-pay-ars\` | ARS | Idem |
| \`iol\` | ARS | **No cargar**: el servidor lo actualiza solo desde IOL todos los días hábiles |
| \`virtual-ars\`, \`cripto-usdt\` | ARS / USDT | Solo si el usuario te pasa el valor |
| \`obra-ars\`, \`obra-usd\` | ARS / USD | **No cargar**: son los gastos de la obra y se leen solos de su planilla de Google |

Podés crear cuentas nuevas con \`POST /accounts\` (por ejemplo \`efectivo-ars\`, \`wallbit-ars\`). Una cuenta tiene una sola moneda: si una institución maneja pesos y dólares, usá dos cuentas.

## Rutina recomendada

1. \`GET /summary\` muestra para cada cuenta su saldo, \`stale_days\` (días desde el último saldo) y la fecha del último movimiento. Con eso sabés qué falta actualizar.
2. Saldos: \`POST /balances\` con \`[{ "account_id": "wallbit", "amount": 1234.56, "as_of": "2026-11-11" }]\`. Un saldo es una foto: no se suma, reemplaza al anterior en esa fecha.
3. Movimientos: \`POST /transactions\` con \`{ "transactions": [ ... ] }\` (hasta 2000 por request). Si es una tanda grande, mandala primero con \`"dry_run": true\` para ver el resultado sin guardar.
4. Revisá la respuesta: cada ítem vuelve con \`status\` = \`created\` | \`updated\` | \`unchanged\` | \`duplicate\` | \`error\` (con \`errors\` explicando qué corregir).

## Reglas de los movimientos

- \`amount\` negativo = sale plata de esa cuenta. Positivo = entra.
- \`external_id\`: **siempre que puedas**. Usá el ID de operación de la app (MP muestra "Número de operación"). Reenviar el mismo \`external_id\` actualiza el movimiento en lugar de duplicarlo, así que podés re-sincronizar un período sin miedo. Si no hay ID visible, armalo determinístico: \`<account_id>:<fecha>:<monto>:<descripcion-corta>\`.
- Sin \`external_id\`, el servidor rechaza como \`duplicate\` un movimiento con igual cuenta + fecha + monto + descripción. Si de verdad son dos (dos cafés iguales el mismo día), mandá \`external_id\` distintos o \`"allow_duplicate": true\`.
- \`kind\`:
  - \`expense\` (gasto) / \`income\` (ingreso): opcional, se deduce del signo.
  - \`transfer\`: **obligatorio** para movimientos entre cuentas propias (MP → Wallbit, depósito a IOL, transferencia a nombre propio). Cargalo en las dos puntas si tenés las dos, cada una con su signo. Las transferencias no cuentan como ingreso ni gasto.
  - \`ignored\`: operaciones rechazadas, canceladas o pendientes.
- **No cargues** compras/ventas de acciones dentro de IOL o Wallbit: no son gastos, ya se reflejan en el saldo. Sí cargá dividendos e intereses cobrados como \`income\`.
- **Pagos de la obra:** cargá igual las transferencias de MercadoPago u otra cuenta a quienes trabajan en la obra, como cualquier movimiento. El servidor las cruza con la planilla de la obra (por número de operación, o por monto y fecha) y las pasa a \`Pago de obra\` para no contar el gasto dos veces. Mandá el número de operación en \`external_id\` cuando lo tengas.
- \`category\`: opcional. Si no la mandás, el servidor aplica sus reglas por descripción/contraparte (\`GET /rules\`). Mandala solo si estás seguro; usá nombres existentes (\`GET /categories\`).
- Algunas reglas del usuario son \`override\`: deciden sueldos, cambios de moneda, transferencias propias y pagos de obra aunque mandes otro \`kind\` o \`category\`. No hace falta pelear con eso: mandá el movimiento con su descripción y contraparte reales.
- \`counterparty\`: mandá el **nombre** de la persona siempre que lo tengas (no solo el ID de usuario de MercadoPago): las reglas reconocen a la gente por nombre.
- \`counterparty\`: nombre de la persona o comercio, ayuda a categorizar.

### Ejemplo

\`\`\`json
POST ${api}/transactions
{
  "transactions": [
    { "account_id": "mercadopago-ars", "date": "2026-11-10", "amount": -18500, "description": "Pago en PedidosYa", "counterparty": "PedidosYa", "external_id": "mp:91234567890" },
    { "account_id": "mercadopago-ars", "date": "2026-11-10", "amount": 850000, "description": "Transferencia recibida", "counterparty": "Empresa SA", "kind": "income", "category": "Sueldo", "external_id": "mp:91234567891" },
    { "account_id": "mercadopago-ars", "date": "2026-11-09", "amount": -500000, "description": "Transferencia a Wallbit", "kind": "transfer", "external_id": "mp:91234567000" }
  ]
}
\`\`\`

## Otras rutas útiles

- \`GET /transactions?from=2026-11-01&to=2026-11-30&account_id=wallbit&q=texto\`: listar/buscar.
- \`PATCH /transactions/{id}\`: corregir \`category\`, \`kind\`, \`description\`, \`amount\`, \`date\` o \`note\`.
- \`DELETE /transactions/{id}\`: borrar un movimiento cargado por error.
- \`POST /rules\` \`{ "pattern": "regex", "category": "...", "direction": "out", "kind": "expense", "priority": 75 }\`: nueva regla (regex sobre descripción + contraparte, en minúsculas y sin tildes; gana la prioridad más baja). Después \`POST /rules/reapply\` re-categoriza lo existente (no toca categorías puestas a mano ni las que mandaste explícitas).
- \`GET /cashflow?from=&to=\`: ingresos/gastos por mes y por categoría, en ARS y USD MEP.
- \`GET /net-worth\` y \`GET /net-worth/history\`: patrimonio actual e histórico.
- \`GET /audit\`: últimos cambios hechos por el bot y la UI.
`;
  }

  const ref = name => ({ $ref: `#/components/schemas/${name}` });

  function openapi() {
    return {
      openapi: '3.1.0',
      info: { title: 'Finanzas personales', version: '1.0.0', description: `Guía de uso: ${api}/guide` },
      servers: [{ url: api }],
      security: [{ bearer: [] }],
      components: {
        securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
        schemas: {
          Account: {
            type: 'object',
            required: ['id', 'institution', 'name', 'currency'],
            properties: {
              id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,40}$', examples: ['wallbit'] },
              institution: { type: 'string', examples: ['wallbit', 'iol', 'mercadopago'] },
              name: { type: 'string' },
              currency: { type: 'string', enum: ['ARS', 'USD', 'USDT'] },
              kind: { type: 'string', enum: ['cuenta', 'inversion', 'cripto', 'efectivo'], default: 'cuenta' },
              notes: { type: 'string' },
              archived: { type: 'boolean' }
            }
          },
          BalanceInput: {
            type: 'object',
            required: ['account_id', 'amount'],
            properties: {
              account_id: { type: 'string' },
              amount: { type: 'number', description: 'Saldo total de la cuenta en su moneda' },
              currency: { type: 'string', description: 'Opcional; si viene debe coincidir con la cuenta' },
              as_of: { type: 'string', description: 'YYYY-MM-DD o ISO 8601; default ahora' },
              note: { type: 'string' }
            }
          },
          TransactionInput: {
            type: 'object',
            required: ['account_id', 'date', 'amount'],
            properties: {
              account_id: { type: 'string' },
              date: { type: 'string', format: 'date' },
              amount: { type: 'number', description: 'Negativo = sale plata, positivo = entra' },
              currency: { type: 'string', description: 'Opcional; debe coincidir con la cuenta' },
              description: { type: 'string' },
              counterparty: { type: 'string' },
              kind: { type: 'string', enum: ['income', 'expense', 'transfer', 'ignored'] },
              category: { type: 'string' },
              subcategory: { type: 'string' },
              external_id: { type: 'string', description: 'ID estable de la operación; reenviarlo actualiza en vez de duplicar' },
              allow_duplicate: { type: 'boolean' },
              note: { type: 'string' },
              raw: { description: 'Datos originales opcionales (se guardan truncados a 4KB)' }
            }
          },
          TransactionPatch: {
            type: 'object',
            properties: {
              category: { type: 'string' },
              subcategory: { type: 'string' },
              kind: { type: 'string', enum: ['income', 'expense', 'transfer', 'ignored'] },
              description: { type: 'string' },
              counterparty: { type: 'string' },
              amount: { type: 'number' },
              date: { type: 'string', format: 'date' },
              note: { type: 'string' }
            }
          },
          Rule: {
            type: 'object',
            required: ['pattern', 'category'],
            properties: {
              pattern: { type: 'string', description: 'Regex (case-insensitive) sobre descripción + contraparte normalizadas' },
              category: { type: 'string' },
              subcategory: { type: 'string' },
              direction: { type: ['string', 'null'], enum: ['in', 'out', null] },
              kind: { type: ['string', 'null'], enum: ['income', 'expense', 'transfer', 'ignored', null] },
              priority: { type: 'integer', default: 75 },
              note: { type: 'string' },
              account_id: { type: ['string', 'null'], description: 'Solo movimientos de esta cuenta' },
              min_amount: { type: ['number', 'null'], description: 'Monto mínimo, sin signo' },
              max_amount: { type: ['number', 'null'], description: 'Monto máximo, sin signo' },
              day_from: { type: ['integer', 'null'], minimum: 1, maximum: 31, description: 'Desde este día del mes' },
              day_to: { type: ['integer', 'null'], minimum: 1, maximum: 31, description: 'Hasta este día del mes' },
              override: { type: 'boolean', default: false, description: 'Gana sobre el kind/category que mande quien carga el movimiento' }
            }
          },
          ItemResult: {
            type: 'object',
            properties: {
              index: { type: 'integer' },
              status: { type: 'string', enum: ['created', 'updated', 'unchanged', 'duplicate', 'error'] },
              id: { type: 'integer' },
              category: { type: 'string' },
              kind: { type: 'string' },
              warnings: { type: 'array', items: { type: 'string' } },
              errors: { type: 'array', items: { type: 'string' } }
            }
          }
        }
      },
      paths: {
        '/summary': { get: { summary: 'Estado general: saldos, antigüedad de cada cuenta, cashflow de los últimos meses', parameters: [{ name: 'months', in: 'query', schema: { type: 'integer', default: 3 } }] } },
        '/accounts': {
          get: { summary: 'Listar cuentas con su último saldo' },
          post: { summary: 'Crear o actualizar una cuenta', requestBody: { content: { 'application/json': { schema: ref('Account') } } } }
        },
        '/accounts/{accountId}': { patch: { summary: 'Modificar una cuenta', parameters: [{ name: 'accountId', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { content: { 'application/json': { schema: ref('Account') } } } } },
        '/balances': {
          get: { summary: 'Historial de saldos', parameters: ['account_id', 'from', 'to', 'limit'].map(name => ({ name, in: 'query', schema: { type: 'string' } })) },
          post: {
            summary: 'Registrar saldos (uno o varios)',
            requestBody: { content: { 'application/json': { schema: { oneOf: [ref('BalanceInput'), { type: 'array', items: ref('BalanceInput') }, { type: 'object', properties: { balances: { type: 'array', items: ref('BalanceInput') } } }] } } } },
            responses: { 200: { description: 'Resultado por ítem', content: { 'application/json': { schema: { type: 'object', properties: { results: { type: 'array', items: ref('ItemResult') } } } } } } }
          }
        },
        '/balances/{id}': { delete: { summary: 'Borrar un saldo', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }] } },
        '/transactions': {
          get: { summary: 'Listar/buscar movimientos', parameters: ['from', 'to', 'account_id', 'institution', 'category', 'kind', 'q', 'limit', 'offset'].map(name => ({ name, in: 'query', schema: { type: 'string' } })) },
          post: {
            summary: 'Cargar movimientos (idempotente por external_id)',
            requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { transactions: { type: 'array', items: ref('TransactionInput'), maxItems: 2000 }, dry_run: { type: 'boolean' } } } } } },
            responses: { 200: { description: 'Conteos y resultado por ítem', content: { 'application/json': { schema: { type: 'object', properties: { dry_run: { type: 'boolean' }, counts: { type: 'object' }, results: { type: 'array', items: ref('ItemResult') } } } } } } }
          }
        },
        '/transactions/{id}': {
          get: { summary: 'Ver un movimiento', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }] },
          patch: { summary: 'Corregir un movimiento', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], requestBody: { content: { 'application/json': { schema: ref('TransactionPatch') } } } },
          delete: { summary: 'Borrar un movimiento', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }] }
        },
        '/categories': { get: { summary: 'Categorías usadas, con conteo' } },
        '/rules': {
          get: { summary: 'Reglas de categorización' },
          post: { summary: 'Agregar regla', requestBody: { content: { 'application/json': { schema: ref('Rule') } } } }
        },
        '/rules/{id}': { delete: { summary: 'Borrar regla', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }] } },
        '/rules/reapply': { post: { summary: 'Re-aplicar reglas a movimientos categorizados automáticamente' } },
        '/cashflow': { get: { summary: 'Ingresos y gastos por mes y categoría (ARS y USD MEP)', parameters: ['from', 'to', 'account_id', 'institution'].map(name => ({ name, in: 'query', schema: { type: 'string' } })) } },
        '/net-worth': { get: { summary: 'Patrimonio a una fecha', parameters: [{ name: 'date', in: 'query', schema: { type: 'string', format: 'date' } }] } },
        '/net-worth/history': { get: { summary: 'Serie de patrimonio', parameters: ['from', 'to'].map(name => ({ name, in: 'query', schema: { type: 'string', format: 'date' } })) } },
        '/fx': { get: { summary: 'Dólar MEP/CCL/oficial vigente a una fecha', parameters: [{ name: 'date', in: 'query', schema: { type: 'string', format: 'date' } }] } },
        '/audit': { get: { summary: 'Últimos cambios', parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }] } }
      }
    };
  }

  return { guide, openapi };
}

module.exports = { createDocs };
