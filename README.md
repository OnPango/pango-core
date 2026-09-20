# Onpango
Sistema ERP especializado en la gestión inteligente de inventarios en pequeñas y medianas empresas (pymes), con trazabilidad de existencias, predicción de demanda y alertas de reposición.

> Proyecto de grado — Departamento de Ingeniería de Sistemas y Computación, Universidad del Norte (Barranquilla, Colombia).

## Integrantes

- Esteban Dadul
- Andrés Monserrat
- Judith Pérez
- Carlos Arango

## Problema

Las pymes con inventario físico suelen llevar registros manuales o dispersos, no miden la rotación por ítem y no analizan la demanda que generan sus áreas internas. Pango busca controlar el inventario y anticipar la demanda partiendo de un volumen de datos históricos limitado.

## Qué incluye

- **Inventario:** catálogo de materiales, stock derivado de movimientos (entradas, salidas, ajustes) y trazabilidad.
- **Solicitudes internas:** registro de consumo por material, área y periodo, que alimenta el histórico de demanda.
- **Motor de predicción:** pronóstico de demanda, stock de seguridad y punto de reorden (ROP), con el modelo elegido por serie mediante validación temporal.
- **Alertas:** aviso cuando un material se acerca a su punto de reorden.
- **Multi-organización (multi-tenant):** una instancia atiende a varias pymes con datos aislados.

<!-- Fuera del alcance del MVP: RFID (plugin opcional futuro), transporte, permisos operativos, hoja de vida de herramientas y control financiero. -->

## Arquitectura

| Componente | Carpeta | Tecnología | Puerto |
|---|---|---|---|
| ERP core (monolito modular) | `erp-core/` | _por definir_ | 3000 |
| Servicio de IA | `ai-service/` | Python, FastAPI | 8000 |
| Base de datos | — | PostgreSQL | 5432 |

El ERP registra las transacciones; el servicio de IA lee el historial, calcula los parámetros de inventario y los guarda para que el ERP genere las alertas.

## Requisitos

- Docker y Docker Compose
- Git

## Puesta en marcha

```bash
git clone <url-del-repositorio>
cd pango
cp .env.example .env      # ajusta los valores
docker compose up --build
```

<!-- Verificación: validar(Esteban)

- ERP core: http://localhost:3000/health
- Servicio de IA: http://localhost:8000/health
 -->
## Estructura del repositorio

```
pango/
├── README.md
├── .gitignore
├── .env.example
├── docker-compose.yml
├── erp-core/          (código NestJS)
│   ├── Dockerfile
│   └── .dockerignore
├── ai-service/
│   ├── Dockerfile
│   ├── .dockerignore
│   ├── requirements.txt
│   └── main.py
├── notebooks/.gitkeep
└── data/ (datasets)
    ├── raw/.gitkeep
    └── processed/.gitkeep
```

## Datos

Los datasets no se incluyen en el repositorio (tamaño y licencias). Descárgalos y colócalos en `data/raw/`:

| Dataset | Uso | Fuente |
|---|---|---|
| Store Item Demand Forecasting Challenge | Desarrollo y prueba del pipeline | Kaggle |
| Online Retail II | Prueba con demanda intermitente | UCI Machine Learning Repository |
| Tienda Virtual del Estado Colombiano (`rgxm-mmea`) | Referencia de tiempos de entrega de proveedores | datos.gov.co |

## Flujo de trabajo

- **Ramas principales:** `main` (producción) y `develop` (integración).
- **Ramas temporales:**
  - `feature/<nombre>` → nace de `develop`, se fusiona en `develop`.
  - `release/<x.y.z>` → nace de `develop`, se fusiona en `main` y `develop`.
  - `hotfix/<x.y.z>` → nace de `main`, se fusiona en `main` y `develop`.
  - `bugfix/<nombre>` → nace de `develop`, se fusiona en `develop`.
- **Los cambios entran por Pull Request** desde las ramas temporales hacia su rama destino. Nunca se hace commit directo en `main` ni en `develop`.
- **Mensajes de commit:** `feat:`, `fix:`, `docs:`, `chore:`.
- **No subir** `.env`, credenciales ni datos crudos.

## Estado del proyecto

- [ ] Fase 0: decisiones de diseño
- [ ] Fase 1: repositorio y entorno Docker
- [ ] Fase 2: modelo de datos
- [ ] Fase 3: datos y seeder
- [ ] Fase 4: ERP core
- [ ] Fase 5: modelo predictivo (notebook)
- [ ] Fase 6: servicio de IA
- [ ] Fase 7: alertas y panel
- [ ] Fase 8: validación y piloto

## Licencia

Por definir.

Cuando decidas el stack del ERP, completa la fila de tecnología y la URL del clon.
