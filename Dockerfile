# A imagem da Playwright já traz o Chromium e todas as bibliotecas de sistema
# que ele precisa. A versão TEM que casar com a do pacote `playwright` no
# package.json, senão o navegador instalado não corresponde ao driver.
ARG PLAYWRIGHT_VERSION=v1.51.1-jammy

# --- Estágio 1: compilação ---------------------------------------------------
FROM mcr.microsoft.com/playwright:${PLAYWRIGHT_VERSION} AS builder

WORKDIR /build

# Dependências em camada própria: só é reinstalada quando os manifests mudam,
# em vez de a cada boot do container.
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN yarn build

# --- Estágio 2: execução -----------------------------------------------------
FROM mcr.microsoft.com/playwright:${PLAYWRIGHT_VERSION}

ENV NODE_ENV=production
WORKDIR /app

# Só as dependências de produção: o TypeScript e o tsx ficam no builder.
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production && yarn cache clean

COPY --from=builder /build/dist ./dist

# tmp/ guarda o storageState.json e precisa ser gravável pelo usuário não-root.
RUN mkdir -p tmp && chown -R pwuser:pwuser /app
USER pwuser

CMD ["node", "dist/index.js"]
