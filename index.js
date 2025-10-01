import express from "express";
import cors from "cors";
import fetch from "node-fetch";

// dotenv en dev
if (process.env.NODE_ENV !== "production") {
  const dotenv = await import('dotenv');
  dotenv.config();
}

const app = express();
const PORT = process.env.PORT || 3000;

// 🔒 Autorise ton domaine (à ajuster/renforcer en prod)
app.use(cors({
  origin: ["https://decathlon.re", "https://www.decathlon.re"],
}));

// ▼ ENV requis
const SHOP = process.env.SHOPIFY_SHOP; // ex: decathlon-re.myshopify.com
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN; // Admin API access token

const ADMIN_GQL = `https://${SHOP}/admin/api/2024-07/graphql.json`; // version récente
const ADMIN_HEADERS = {
  "Content-Type": "application/json",
  "X-Shopify-Access-Token": ADMIN_TOKEN,
};

// ---------- Utils détection & extraction ----------

function isEAN(s) {
  return /^\d{8}$|^\d{12,14}$/.test(s.trim());
}
function isModel(s) {
  // modèle Décathlon 6–8 chiffres
  return /^\d{6,8}$/.test(s.trim());
}
function isSKU(s) {
  // alphanum (avec - _ .) longueur ≥ 5
  return /^[A-Z0-9._-]{5,}$/i.test(s.trim());
}
function isURL(s) {
  return /^https?:\/\//i.test(s.trim());
}

/**
 * Essaie d'extraire des "candidats" (ean, sku, model) d'un contenu brut.
 * - Si URL : regarde query params typiques (ean, gtin, sku, model, code),
 *   et scrape aussi le dernier segment numérique du path.
 * - Si pas URL : renvoie la string telle quelle comme unique candidat.
 */
function extractCandidates(raw) {
  const out = new Set();

  if (!raw) return [];

  const s = String(raw).trim();

  if (isURL(s)) {
    try {
      const u = new URL(s);

      // 1) Paramètres connus
      const candKeys = ["ean", "gtin", "barcode", "sku", "model", "code", "id"];
      candKeys.forEach(k => {
        const v = u.searchParams.get(k);
        if (v) out.add(v.trim());
      });

      // 2) Dernier segment numérique du path (ex: /p/3608459693135)
      const segs = u.pathname.split("/").filter(Boolean);
      if (segs.length) {
        const last = segs[segs.length - 1];
        // garde si ça ressemble à un code (chiffres ou alphanum compact)
        if (/^[A-Z0-9._-]+$/i.test(last)) out.add(last);
      }

      // 3) Fragments éventuels (#code=xxxx)
      const frag = u.hash.replace(/^#/, "");
      const m = frag.match(/(ean|gtin|barcode|sku|model|code)=([A-Z0-9._-]+)/i);
      if (m) out.add(m[2]);

    } catch (_) {
      // si l'URL throw, on tombera dans le fallback "brut"
    }
  } else {
    out.add(s);
  }

  // On retourne une liste unique, try-order utile : EAN → SKU → Model → reste
  const list = Array.from(out);

  // Tri heuristique pour tester d'abord EAN, puis SKU, puis Model
  list.sort((a, b) => {
    const score = (x) => (isEAN(x) ? 3 : isSKU(x) ? 2 : isModel(x) ? 1 : 0);
    return score(b) - score(a);
  });

  return list;
}

// ---------- Requêtes GraphQL Admin ----------

const Q_VARIANT_BY_QUERY = `
  query VariantByQuery($q: String!) {
    productVariants(first: 1, query: $q) {
      edges {
        node {
          id
          sku
          barcode
          product { id handle title }
        }
      }
    }
  }
`;

const Q_PRODUCTS_BY_QUERY = `
  query ProductsByQuery($q: String!) {
    products(first: 3, query: $q) {
      edges {
        node {
          id
          handle
          title
          variants(first: 1) { edges { node { id } } }
        }
      }
    }
  }
`;

/**
 * Appelle l'Admin GQL
 */
async function adminGQL(query, variables) {
  const r = await fetch(ADMIN_GQL, {
    method: "POST",
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ query, variables })
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

/**
 * Essaie de trouver un handle PDP à partir d'un code unique.
 * Stratégie :
 *  1) barcode:
 *  2) sku:
 *  3) products par tag "Model: NNNNNN" OU recherche libre avec le code
 */
async function resolveHandleFromCode(code) {
  const c = String(code).trim();

  // 1) barcode
  if (isEAN(c)) {
    const d = await adminGQL(Q_VARIANT_BY_QUERY, { q: `barcode:${c}` });
    const v = d.productVariants.edges[0]?.node;
    if (v?.product?.handle) {
      return { handle: v.product.handle, variantId: v.id, source: "barcode" };
    }
  }

  // 2) sku
  if (isSKU(c)) {
    const d = await adminGQL(Q_VARIANT_BY_QUERY, { q: `sku:${c}` });
    const v = d.productVariants.edges[0]?.node;
    if (v?.product?.handle) {
      return { handle: v.product.handle, variantId: v.id, source: "sku" };
    }
  }

  // 3) model (Décathlon) via tag "Model: NNNNNN"
  if (isModel(c)) {
    // Cherche d'abord via tag strict
    let d = await adminGQL(Q_PRODUCTS_BY_QUERY, { q: `tag:"Model: ${c}"` });
    let p = d.products.edges[0]?.node;
    if (p?.handle) {
      const vId = p.variants.edges[0]?.node?.id;
      return { handle: p.handle, variantId: vId, source: "tag:model" };
    }

    // Fallback : recherche libre (peut matcher titre/sku/handle… selon indexation)
    d = await adminGQL(Q_PRODUCTS_BY_QUERY, { q: c });
    p = d.products.edges[0]?.node;
    if (p?.handle) {
      const vId = p.variants.edges[0]?.node?.id;
      return { handle: p.handle, variantId: vId, source: "search:model" };
    }
  }

  // 4) Dernier fallback : recherche libre pour tout code “autre”
  const d = await adminGQL(Q_PRODUCTS_BY_QUERY, { q: c });
  const p = d.products.edges[0]?.node;
  if (p?.handle) {
    const vId = p.variants.edges[0]?.node?.id;
    return { handle: p.handle, variantId: vId, source: "search:any" };
  }

  return null;
}

// ---------- Routes ----------

app.get("/", (_req, res) => {
  res.send("🟢 Scanner Router API - Online");
});

/**
 * JSON: résout un "raw" (URL / EAN / SKU / Model) en PDP
 * GET /scan-lookup?raw=...
 */
app.get("/scan-lookup", async (req, res) => {
  const raw = req.query.raw;
  if (!raw) return res.status(400).json({ error: "Missing raw param" });

  try {
    const candidates = extractCandidates(raw);

    for (const cand of candidates) {
      const result = await resolveHandleFromCode(cand);
      if (result?.handle) {
        const variantIdShort = result.variantId?.split("/").pop();
        const url = variantIdShort
          ? `https://decathlon.re/products/${result.handle}?variant=${variantIdShort}`
          : `https://decathlon.re/products/${result.handle}`;
        return res.json({ ...result, url, tried: candidates });
      }
    }

    // pas trouvé → fallback recherche
    return res.json({
      handle: null,
      url: `https://decathlon.re/search?q=${encodeURIComponent(String(raw).trim())}`,
      source: "fallback:search",
      tried: candidates
    });
  } catch (e) {
    console.error("scan-lookup error", e);
    return res.status(500).json({ error: "lookup_failed" });
  }
});

/**
 * Redirect: idéal pour front
 * GET /r?raw=...
 */
app.get("/r", async (req, res) => {
  const raw = req.query.raw;
  if (!raw) return res.status(400).send("Missing raw");

  try {
    const candidates = extractCandidates(raw);

    for (const cand of candidates) {
      const result = await resolveHandleFromCode(cand);
      if (result?.handle) {
        const variantIdShort = result.variantId?.split("/").pop();
        const url = variantIdShort
          ? `https://decathlon.re/products/${result.handle}?variant=${variantIdShort}`
          : `https://decathlon.re/products/${result.handle}`;
        return res.redirect(302, url);
      }
    }

    // fallback : recherche
    return res.redirect(302, `https://decathlon.re/search?q=${encodeURIComponent(String(raw).trim())}`);
  } catch (e) {
    console.error("redirect error", e);
    return res.redirect(302, `https://decathlon.re/search?q=${encodeURIComponent(String(raw).trim())}`);
  }
});

app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});

