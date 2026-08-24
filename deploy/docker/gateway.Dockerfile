FROM node:24-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/gateway/package.json apps/gateway/package.json
COPY apps/cli/package.json apps/cli/package.json
COPY apps/console/package.json apps/console/package.json
COPY packages/canonical/package.json packages/canonical/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/providers/package.json packages/providers/package.json
COPY packages/routing/package.json packages/routing/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/evals/package.json packages/evals/package.json
RUN npm ci --ignore-scripts

COPY . .
RUN npm run prisma:generate && npm run build

FROM build AS production-dependencies
RUN npm prune --omit=dev

FROM node:24-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/apps/gateway/dist ./apps/gateway/dist
COPY --from=build /app/apps/console/dist ./apps/console/dist
COPY --from=build /app/packages/canonical/dist ./packages/canonical/dist
COPY --from=build /app/packages/config/dist ./packages/config/dist
COPY --from=build /app/packages/providers/dist ./packages/providers/dist
COPY --from=build /app/packages/routing/dist ./packages/routing/dist
COPY --from=build /app/packages/database/dist ./packages/database/dist
COPY --from=build /app/packages/database/src/generated ./packages/database/src/generated
COPY --from=build /app/apps/gateway/package.json ./apps/gateway/package.json
COPY --from=build /app/apps/console/package.json ./apps/console/package.json
COPY --from=build /app/packages/canonical/package.json ./packages/canonical/package.json
COPY --from=build /app/packages/config/package.json ./packages/config/package.json
COPY --from=build /app/packages/providers/package.json ./packages/providers/package.json
COPY --from=build /app/packages/routing/package.json ./packages/routing/package.json
COPY --from=build /app/packages/database/package.json ./packages/database/package.json
COPY --from=build /app/configs ./configs
COPY package.json ./

EXPOSE 8080
CMD ["node", "apps/gateway/dist/main.js"]
