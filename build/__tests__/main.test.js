"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const db_1 = require("./fixture/db");
const client_1 = require("./fixture/client");
const http_1 = require("http");
const freeport_1 = require("./fixture/freeport");
const postgraphile_upsert_1 = require("../postgraphile-upsert");
const postgraphile_1 = require("postgraphile");
const ava_1 = __importDefault(require("ava"));
const nanographql = require("nanographql");
const Bluebird = require("bluebird");
const node_fetch_1 = __importDefault(require("node-fetch"));
const test = ava_1.default;
test.beforeEach(async (t) => {
    await db_1.container.setup(t.context);
    await Bluebird.delay(5000);
    t.context.client = await client_1.createPool(t.context.dbConfig);
    t.context.client.on("error", (_err) => { });
    await t.context.client.query(`
    create table bikes (
      id serial,
      weight real,
      make varchar,
      model varchar,
      serial_key varchar,
      primary key (id),
      CONSTRAINT serial_weight_unique UNIQUE (serial_key, weight)
    )
  `);
    await t.context.client.query(`
    create table roles (
      id serial primary key,
      project_name varchar,
      title varchar,
      name varchar,
      rank integer,
      unique (project_name, title)
    )
  `);
    await t.context.client.query(`
      create table no_primary_keys(
        name text
      )
  `);
    const middleware = postgraphile_1.postgraphile(t.context.client, "public", {
        graphiql: true,
        appendPlugins: [postgraphile_upsert_1.PgMutationUpsertPlugin],
        exportGqlSchemaPath: "./postgraphile.graphql",
    });
    t.context.middleware = middleware;
    const serverPort = await freeport_1.freeport();
    t.context.serverPort = serverPort;
    t.context.server = http_1.createServer(middleware).listen(serverPort);
});
test.afterEach(async (t) => {
    t.context.client.on("error", () => null);
    db_1.container.teardown(t.context).catch(console.error);
    await t.context.middleware.release();
    await new Promise((res) => t.context.server.close(res));
});
const execGqlOp = (t, query) => node_fetch_1.default(`http://localhost:${t.context.serverPort}/graphql`, {
    body: query(),
    headers: {
        "Content-Type": "application/json",
    },
    method: "POST",
}).then(async (res) => {
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`op failed: ${res.statusText}\n\n${text}`);
    }
    const json = await res.json();
    if (json.errors)
        throw new Error(JSON.stringify(json.errors));
    return json;
});
const fetchMutationTypes = async (t) => {
    const query = nanographql `
    query {
      __type(name: "Mutation") {
        name
        fields {
          name
        }
      }
    }
  `;
    return execGqlOp(t, query);
};
const fetchAllBikes = async (t) => {
    const query = nanographql `
    query {
      allBikes {
        edges {
          node {
            id
            make
            model
          }
        }
      }
    }
  `;
    return execGqlOp(t, query);
};
const fetchAllRoles = async (t) => {
    const query = nanographql `
  query {
    allRoles(orderBy: RANK_ASC) {
      edges {
        node {
          id
          projectName
          title
          name
          rank
        }
      }
    }
  }`;
    return execGqlOp(t, query);
};
const create = async (t, extraProperties = {}) => {
    const mutation = `mutation {
    upsertBike(input: {
      bike: {
        weight: 0.0
        make: "kona"
        model: "cool-ie deluxe"
        ${Object.entries(extraProperties)
        .map(([property, value]) => `${property}: ${value}`)
        .join("\n")}
      }
    }) {
      clientMutationId
    }
  }`;
    return execGqlOp(t, nanographql(mutation));
};
test("ignores tables without primary keys", async (t) => {
    await create(t);
    const res = await fetchMutationTypes(t);
    const upsertMutations = new Set(res.data.__type.fields
        .map(({ name }) => name)
        .filter((name) => name.startsWith("upsert")));
    t.assert(upsertMutations.size === 2);
    t.assert(upsertMutations.has("upsertBike"));
    t.assert(upsertMutations.has("upsertRole"));
});
test("upsert crud - match primary key constraint", async (t) => {
    await create(t); // test upsert without where clause
    const res = await fetchAllBikes(t);
    t.is(res.data.allBikes.edges.length, 1);
    t.is(res.data.allBikes.edges[0].node.make, "kona");
});
test("upsert crud - match unique constraint", async (t) => {
    await create(t, { serialKey: '"123"' }); // test upsert without where clause
    const res = await fetchAllBikes(t);
    t.is(res.data.allBikes.edges.length, 1);
    t.is(res.data.allBikes.edges[0].node.make, "kona");
});
test("Ensure valid values are included (i.e. 0.0 for numerics)", async (t) => {
    await create(t, { serialKey: '"123"' });
    const query = nanographql(`
    mutation {
      upsertBike(where: {
        weight: 0.0,
        serialKey: "123"
      },
      input: {
        bike: {
          model: "cool-ie deluxe v2"
          weight: 0.0,
          serialKey: "123"
        }
      }) {
        clientMutationId
      }
    }
  `);
    await execGqlOp(t, query);
    const res = await fetchAllBikes(t);
    t.is(res.data.allBikes.edges.length, 1);
    t.is(res.data.allBikes.edges[0].node.model, "cool-ie deluxe v2");
});
test("Includes where clause values if ommitted from input", async (t) => {
    await create(t, { serialKey: '"123"' });
    // Hit unique key with weight/serialKey, but omit from input entry
    const query = nanographql(`
    mutation {
      upsertBike(where: {
        weight: 0.0,
        serialKey: "123"
      },
      input: {
        bike: {
          model: "cool-ie deluxe v2"
        }
      }) {
        clientMutationId
      }
    }
  `);
    await execGqlOp(t, query);
    const res = await fetchAllBikes(t);
    t.is(res.data.allBikes.edges.length, 1);
    t.is(res.data.allBikes.edges[0].node.model, "cool-ie deluxe v2");
});
test("throws an error if input values differ from where clause values", async (t) => {
    try {
        await create(t, { serialKey: '"123"' });
        const query = nanographql(`
      mutation {
        upsertBike(where: {
          weight: 0.0,
          serialKey: "123"
        },
        input: {
          bike: {
            model: "cool-ie deluxe v2"
            weight: 0.0,
            serialKey: "1234"
          }
        }) {
          clientMutationId
        }
      }
    `);
        await execGqlOp(t, query);
        t.fail("Mutation should fail if values differ");
    }
    catch (e) {
        t.truthy(e.message.includes("Value passed in the input for serialKey does not match the where clause value."));
    }
});
test("upsert where clause", async (t) => {
    const upsertDirector = async ({ projectName = "sales", title = "director", name = "jerry", rank = 1, }) => {
        const query = nanographql(`
      mutation {
        upsertRole(where: {
          projectName: "sales",
          title: "director"
        },
        input: {
          role: {
            projectName: "${projectName}",
            title: "${title}",
            name: "${name}",
            rank: ${rank}
          }
        }) {
          clientMutationId
        }
      }
    `);
        return execGqlOp(t, query);
    };
    {
        // add director
        await upsertDirector({ name: "jerry" });
        const res = await fetchAllRoles(t);
        t.is(res.data.allRoles.edges.length, 1);
        t.is(res.data.allRoles.edges[0].node.projectName, "sales");
        t.is(res.data.allRoles.edges[0].node.title, "director");
        t.is(res.data.allRoles.edges[0].node.name, "jerry");
    }
    {
        // update director
        await upsertDirector({ name: "frank", rank: 2 });
        const res = await fetchAllRoles(t);
        t.is(res.data.allRoles.edges[0].node.projectName, "sales");
        t.is(res.data.allRoles.edges[0].node.title, "director");
        t.is(res.data.allRoles.edges[0].node.name, "frank");
        t.is(res.data.allRoles.edges[0].node.rank, 2);
        // assert only one record
        t.is(res.data.allRoles.edges.length, 1);
    }
});
//# sourceMappingURL=main.test.js.map