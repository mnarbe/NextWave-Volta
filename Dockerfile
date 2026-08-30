# -----------------------------------------------------------------------------
# Volta — imagen para levantar el proyecto sin instalar nada local.
#
# No hay build step: el server corre TypeScript directo con tsx, así que la
# imagen solo instala dependencias y arranca.
# -----------------------------------------------------------------------------
FROM node:22-slim

WORKDIR /app

# Primero el manifiesto: mientras no cambien las dependencias, Docker reusa
# esta capa y el rebuild es casi instantáneo.
COPY package.json package-lock.json ./

# Sin --omit=dev A PROPÓSITO: `npm start` es `tsx src/index.ts`, así que tsx es
# una dependencia de RUNTIME aunque viva en devDependencies.
RUN npm ci

COPY . .

# Estado persistente (mandate.json, negotiations.json, handovers). En compose se
# monta un volumen acá; sin él, se pierde al recrear el contenedor.
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Mismo puerto para el dashboard y para el WebSocket.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/mandate').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
