/**
 * This module MUST be imported before any other api-contracts module.
 * It extends Zod with the .openapi() method globally.
 */
import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);
