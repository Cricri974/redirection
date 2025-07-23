import express from "express";
import fetch from "node-fetch";

// Pas besoin de dotenv sur Render, seulement en local développement
if (process.env.NODE_ENV !== "production") {
  const dotenv = await import('dotenv');
  dotenv.config();
}

const app = express();
const PORT = process.env.PORT || 3000;

// Ces variables sont à définir dans l'onglet "Environment" sur Render
const SHOP = process.env.SHOPIFY_SHOP;
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

app.get("/", (req, res) => {
  res.send("🟢 Shopify Find Product API - Online");
});

app.get("/find-product", async (req, res) => {
  const modelCode = req.query.modelCode;
  if (!modelCode) {
    res.status(400).json({ error: "Missing modelCode param" });
    return;
  }

  try {
    const response = await fetch(
      `https://${SHOP}/admin/api/2023-10/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": ADMIN_TOKEN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: `
            query {
              productVariants(first: 1, query: "option:Model Code:'${modelCode}'") {
                edges {
                  node {
                    id
                    product { handle }
                  }
                }
              }
            }
          `,
        }),
      }
    );

    const data = await response.json();
    const variant = data.data?.productVariants?.edges[0]?.node;

    if (variant) {
      res.json({
        handle: variant.product.handle,
        variantId: variant.id,
        url: `https://${SHOP.replace('.myshopify.com', '')}/products/${variant.product.handle}?variant=${variant.id.split("/").pop()}`
      });
    } else {
      res.status(404).json({ error: "No variant found for this Model Code" });
    }
  } catch (e) {
    res.status(500).json({ error: e.message || "Internal server error" });
  }
});

app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});
