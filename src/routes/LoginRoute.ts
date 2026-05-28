import { Router } from "https://deno.land/x/oak@v10.6.0/mod.ts";
import { logger } from "../helpers/logger.ts";
import { Response } from "../helpers/ApiResponse.ts";
import * as Loader from "../loader.ts";
import { ModuleType } from "../moduleClass.ts";

const router = new Router();

/* A login endpoint for the API. It is using the module login function to get the authTokens. */
router.post(
  `/login`,
  async (context) => {
    const moduleId = context.params.module;
    try {
      let authTokens: string[] = [];
      logger("login", `login request for module '${moduleId}'`);

      const mod: ModuleType = new (await import(
        `${Deno.cwd()}/src/modules/${moduleId}.ts`
      )).default();
      const config = await mod.getAuth();
      const result = await (context.request.body({ type: "json" })).value;

      logger(
        "login",
        `'${moduleId}' login attempt with username ${
          result.username
            ? result.username + " from request"
            : config.username + " from file (request empty)"
        }`,
      );

      authTokens = await Loader.login(
        moduleId!,
        result.username || config.username,
        result.password || config.password,
      );

      const hasValidToken = Array.isArray(authTokens) && Boolean(authTokens[0]);
      if (hasValidToken) {
        logger("login", `'${moduleId}' login success`);
        context.response.body = new Response("SUCCESS", moduleId, authTokens);
        return;
      }

      context.response.status = 401;
      context.response.body = new Response(
        "ERROR",
        moduleId,
        null,
        undefined,
        `Authentication failed for module '${moduleId}' (token missing)`,
      );
    } catch (error) {
      const msg = error?.message || error?.toString?.().substring(0, 200) ||
        "Login failed";
      logger("login", msg, true);
      context.response.status = 500;
      context.response.body = new Response(
        "ERROR",
        moduleId,
        null,
        undefined,
        msg,
      );
    }
  },
);

export default router;
