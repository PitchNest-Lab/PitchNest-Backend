import dns from "dns";
dns.setDefaultResultOrder("ipv4first");
import serverlessExpress from "@codegenie/serverless-express";
import app from "./app.ts";

export const handler = serverlessExpress({ app });