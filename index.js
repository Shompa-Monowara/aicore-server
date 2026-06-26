 const dns = require("node:dns");
 dns.setServers(['1.1.1.1', '1.0.0.1']);

const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
dotenv.config();

const uri = process.env.MONGODB_URI;
const app = express();
const PORT = process.env.PORT;

app.use(
  cors({
    credentials: true,
    origin: [process.env.CLIENT_URL],
  })
);
app.use(express.json());


const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: false, 
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();
    const db = client.db("aicore");

    const promptCollection = db.collection("prompts");
    const userCollection = db.collection("user");
    const reportCollection = db.collection("reports");
    const bookmarkCollection = db.collection("bookmarks");
    const reviewCollection = db.collection("reviews");
    const copyLogCollection = db.collection("copyLogs");
    const paymentCollection = db.collection("payments");

    // ==========================================
    //  PAYMENT SUCCESS ROUTE (FIXED & CLEAN)
    // ==========================================
    app.get("/api/payment/success", async (req, res) => {
      try {
        const { session_id, email, prompt_id } = req.query;

        if (!session_id || !email) {
          return res.status(400).send("Missing session_id or email");
        }

        // duplicate payment entry check
        const existing = await paymentCollection.findOne({ sessionId: session_id });
        
        if (!existing) {
          // payments collection payment entry insert
          const paymentData = {
            sessionId: session_id,
            email: email,
            amount: 5,
            productId: "premium_access",
            title: "Aiverse Pro Access Plan",
            status: "completed",
            createdAt: new Date(),
          };
          await paymentCollection.insertOne(paymentData);

          // user collection plan update 
          await db.collection("user").updateOne(
            { email: email },
            { $set: { plan: "premium", premiumSince: new Date() } }
          );
        }

        const redirectUrl = prompt_id 
          ? `${process.env.CLIENT_URL}/dashboard/user/profile?payment=success&prompt_id=${prompt_id}`
          : `${process.env.CLIENT_URL}/dashboard/user/profile?payment=success`;

        res.redirect(redirectUrl);
      } catch (error) {
        console.error(error);
        res.status(500).send("Internal server error during redirect");
      }
    });
    // ==========================================

    // PROMPT ROUTES
    app.post("/user/prompts", async (req, res) => {
      try {
        const data = req.body;
        const result = await promptCollection.insertOne({
          ...data,
          createdAt: new Date(),
        });
        res.json(result);
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    app.get("/user/prompts", async (req, res) => {
      try {
        const { email } = req.query;
        const query = email ? { email } : {};
        const result = await promptCollection.find(query).toArray();
        const totalData = await promptCollection.countDocuments(query);
        res.json({ data: result, totalData });
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    app.delete("/user/prompts/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const result = await promptCollection.deleteOne({
          _id: new ObjectId(id),
        });
        res.json(result);
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    //PROMPT UPDATE ROUTE (REAL MONGODB OPERATION)

   app.patch("/user/prompts/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const updatedData = req.body;

    
    delete updatedData._id;

  
    const result = await promptCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: updatedData }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ message: "Prompt not found" });
    }

    res.json({ acknowledged: true, modifiedCount: result.modifiedCount });
  } catch (error) {
    console.error("Update failed:", error);
    res.status(500).json({ message: "Internal server error during update" });
  }
});

    app.patch("/prompts/:id/copy", async (req, res) => {
      try {
        const { id } = req.params;
        const { email } = req.body;

        if (email) {
          const user = await userCollection.findOne({ email });
          const isPremium = user?.role === "admin" || (user?.plan && user.plan !== "free");

          if (!isPremium) {
            const alreadyCopied = await copyLogCollection.findOne({ email, promptId: id });

            if (!alreadyCopied) {
              const distinctPrompts = await copyLogCollection.distinct("promptId", { email });
              if (distinctPrompts.length >= 3) {
                return res.status(403).json({
                  limitReached: true,
                  message: "Free users can copy up to 3 prompts only. Upgrade to premium for unlimited copies.",
                });
              }
              await copyLogCollection.insertOne({ email, promptId: id, createdAt: new Date() });
            }
          } else {
            const alreadyCopied = await copyLogCollection.findOne({ email, promptId: id });
            if (!alreadyCopied) {
              await copyLogCollection.insertOne({ email, promptId: id, createdAt: new Date() });
            }
          }
        }

        const result = await promptCollection.updateOne(
          { _id: new ObjectId(id) },
          { $inc: { copyCount: 1 } }
        );
        res.json({ ...result, limitReached: false });
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    app.get("/prompts/public", async (req, res) => {
      try {
        const {
          search = "",
          category = "",
          aiTool = "",
          difficulty = "",
          sort = "latest",
          page = 1,
          limit = 9,
        } = req.query;
        const query = { status: "approved" };

        if (search) {
          query.$or = [
            { title: { $regex: search, $options: "i" } },
            { tags: { $elemMatch: { $regex: search, $options: "i" } } },
            { aiTool: { $regex: search, $options: "i" } },
          ];
        }

        if (category) query.category = category;
        if (aiTool) query.aiTool = aiTool;
        if (difficulty) query.difficulty = difficulty;

        let sortOption = {};
        if (sort === "popular") sortOption = { averageRating: -1 };
        else if (sort === "copied") sortOption = { copyCount: -1 };
        else sortOption = { createdAt: -1 };

        const skip = (parseInt(page) - 1) * parseInt(limit);
        const total = await promptCollection.countDocuments(query);

        const prompts = await promptCollection
          .find(query)
          .sort(sortOption)
          .skip(skip)
          .limit(parseInt(limit))
          .toArray();

        res.json({
          data: prompts,
          total,
          page: parseInt(page),
          totalPages: Math.ceil(total / parseInt(limit)),
        });
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    app.get("/prompts/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const result = await promptCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!result) {
          return res.status(404).json({ message: "Prompt not found" });
        }
        res.json(result);
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    //  Bookmark toggle
    app.post("/bookmarks/toggle", async (req, res) => {
      try {
        const { email, promptId } = req.body;
        if (!email || !promptId) {
          return res.status(400).json({ message: "email and promptId are required" });
        }
        const existing = await bookmarkCollection.findOne({ email, promptId });

        if (existing) {
          await bookmarkCollection.deleteOne({ _id: existing._id });
          return res.json({ bookmarked: false });
        }

        await bookmarkCollection.insertOne({ email, promptId, createdAt: new Date() });
        res.json({ bookmarked: true });
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    //  Bookmark status check
    app.get("/bookmarks/status", async (req, res) => {
      try {
        const { email, promptId } = req.query;
        if (!email || !promptId) return res.json({ bookmarked: false });
        const existing = await bookmarkCollection.findOne({ email, promptId });
        res.json({ bookmarked: !!existing });
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    //  User Bookmarks
    app.get("/bookmarks", async (req, res) => {
      try {
        const { email } = req.query;
        const bookmarks = await bookmarkCollection
          .find(email ? { email } : {})
          .sort({ createdAt: -1 })
          .toArray();

        const promptIds = bookmarks.map((b) => new ObjectId(b.promptId));
        const prompts = promptIds.length
          ? await promptCollection.find({ _id: { $in: promptIds } }).toArray()
          : [];

        res.json({ data: prompts });
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // Review add + prompt এর averageRating recalculate
    app.post("/reviews", async (req, res) => {
      try {
        const { promptId, name, email, rating, comment, aiTool } = req.body;
        if (!promptId || !rating) {
          return res.status(400).json({ message: "promptId and rating are required" });
        }

        await reviewCollection.insertOne({
          promptId,
          name,
          email,
          rating: Number(rating),
          comment,
          aiTool,
          createdAt: new Date(),
        });

        const allReviews = await reviewCollection.find({ promptId }).toArray();
        const avg =
          allReviews.reduce((sum, r) => sum + r.rating, 0) / allReviews.length;

        await promptCollection.updateOne(
          { _id: new ObjectId(promptId) },
          { $set: { averageRating: avg, reviewCount: allReviews.length } }
        );

        res.json({ acknowledged: true, averageRating: avg });
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    //Get reviews with promopt title
    app.get("/reviews", async (req, res) => {
      try {
        const { email } = req.query;
        const query = email ? { email } : {};

        const reviews = await reviewCollection
          .find(query)
          .sort({ createdAt: -1 })
          .toArray();

        const promptIds = reviews
          .filter((r) => r.promptId)
          .map((r) => new ObjectId(r.promptId));

        const prompts = promptIds.length
          ? await promptCollection.find({ _id: { $in: promptIds } }).toArray()
          : [];

        const promptMap = {};
        prompts.forEach((p) => {
          promptMap[p._id.toString()] = p.title;
        });

        const withTitles = reviews.map((r) => ({
          ...r,
          promptTitle: promptMap[r.promptId] || "Unknown Prompt",
        }));

        res.json({ data: withTitles });
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    app.get("/reviews/:promptId", async (req, res) => {
      try {
        const { promptId } = req.params;
        const result = await reviewCollection
          .find({ promptId })
          .sort({ createdAt: -1 })
          .toArray();
        res.json({ data: result });
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    app.post("/reports", async (req, res) => {
      try {
        const data = req.body;
        const result = await reportCollection.insertOne({
          ...data,
          status: "pending",
          createdAt: new Date(),
        });
        res.json(result);
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    //  Payment confirm
    app.post("/payments/confirm", async (req, res) => {
      try {
        const { sessionId, email, amount, productId, title } = req.body;
        if (!sessionId || !email) {
          return res.status(400).json({ message: "sessionId and email are required" });
        }

        const existing = await paymentCollection.findOne({ sessionId });
        if (existing) {
          return res.json({ alreadyProcessed: true, payment: existing });
        }

        const payment = {
          sessionId,
          email,
          amount: Number(amount),
          productId,
          title,
          status: "completed",
          createdAt: new Date(),
        };
        await paymentCollection.insertOne(payment);

        await userCollection.updateOne(
          { email },
          { $set: { plan: "premium", premiumSince: new Date() } }
        );

        res.json({ acknowledged: true, payment });
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // CREATOR DASHBOARD ANALYTICS API 
    // ==========================================
    app.get("/api/creator/analytics", async (req, res) => {
      try {
        const { email } = req.query;
        if (!email) {
          return res.status(400).json({ message: "Email is required" });
        }

        const totalPrompts = await promptCollection.countDocuments({ email });
        const creatorPrompts = await promptCollection.find({ email }).toArray();
        
        let totalCopies = 0;
        const barData = [];
        const promptIdsStr = creatorPrompts.map(p => p._id.toString());

        for (const prompt of creatorPrompts) {
          totalCopies += (prompt.copyCount || 0);
          const bookmarksCount = await bookmarkCollection.countDocuments({ promptId: prompt._id.toString() });
          
          const shortTitle = prompt.title.length > 15 ? prompt.title.substring(0, 15) + "..." : prompt.title;
          barData.push({
            name: shortTitle,
            Bookmarks: bookmarksCount,
            Copies: prompt.copyCount || 0
          });
        }

        const totalBookmarks = await bookmarkCollection.countDocuments({
          promptId: { $in: promptIdsStr }
        });

        const todayStr = new Date().toISOString().split('T')[0];
        const lineData = [
          { name: todayStr, "Total Copies": totalCopies, "Total Prompts": totalPrompts }
        ];

        res.json({
          stats: { totalPrompts, totalCopies, totalBookmarks },
          barData,
          lineData
        });
      } catch (error) {
        console.error("Creator analytics error:", error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // ADMIN ROUTES
    app.get("/admin/analytics", async (req, res) => {
      try {
        const totalPrompts = await promptCollection.countDocuments({});
        const totalUsers = await userCollection.countDocuments({});

        const copyCountAgg = await promptCollection
          .aggregate([{ $group: { _id: null, total: { $sum: "$copyCount" } } }])
          .toArray();
        const totalCopies = copyCountAgg[0]?.total || 0;

        const engineBreakdown = await promptCollection
          .aggregate([
            {
              $group: {
                _id: "$aiTool",
                promptsCount: { $sum: 1 },
                totalCopies: { $sum: "$copyCount" },
              },
            },
          ])
          .toArray();

        const totalReviews = await reviewCollection.countDocuments({});

        const revenueAgg = await paymentCollection
          .aggregate([{ $group: { _id: null, total: { $sum: "$amount" } } }])
          .toArray();
        const totalRevenue = revenueAgg[0]?.total || 0;

        res.json({
          totalUsers,
          totalPrompts,
          totalReviews,
          totalCopies,
          totalRevenue,
          engineBreakdown,
        });
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    app.get("/admin/users", async (req, res) => {
      try {
        const result = await userCollection.find({}).sort({ createdAt: -1 }).toArray();
        res.json({ data: result });
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    app.patch("/admin/users/:id/role", async (req, res) => {
      try {
        const { id } = req.params;
        const { role } = req.body;
        const result = await userCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { role } }
        );
        res.json(result);
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    app.delete("/admin/users/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const result = await userCollection.deleteOne({ _id: new ObjectId(id) });
        res.json(result);
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    app.get("/admin/prompts", async (req, res) => {
      try {
        const result = await promptCollection.find({}).sort({ createdAt: -1 }).toArray();
        const total = await promptCollection.countDocuments({});
        res.json({ data: result, total });
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    app.patch("/admin/prompts/:id/status", async (req, res) => {
      try {
        const { id } = req.params;
        const { status, rejectionFeedback } = req.body;
        const updateData = { status };
        if (status === "rejected" && rejectionFeedback) {
          updateData.rejectionFeedback = rejectionFeedback;
        }
        const result = await promptCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updateData }
        );
        res.json(result);
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    app.delete("/admin/prompts/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const result = await promptCollection.deleteOne({ _id: new ObjectId(id) });
        res.json(result);
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    app.patch("/admin/prompts/:id/feature", async (req, res) => {
      try {
        const { id } = req.params;
        const { featured } = req.body;
        const result = await promptCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { featured } }
        );
        res.json(result);
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    app.get("/admin/reports", async (req, res) => {
      try {
        const result = await reportCollection.find({}).sort({ createdAt: -1 }).toArray();
        res.json({ data: result });
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    app.patch("/admin/reports/:id/dismiss", async (req, res) => {
      try {
        const { id } = req.params;
        const result = await reportCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status: "dismissed" } }
        );
        res.json(result);
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    app.patch("/admin/reports/:id/warn", async (req, res) => {
      try {
        const { id } = req.params;
        const result = await reportCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status: "warned" } }
        );
        res.json(result);
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    app.delete("/admin/reports/:id/remove-prompt", async (req, res) => {
      try {
        const { id } = req.params;
        const report = await reportCollection.findOne({ _id: new ObjectId(id) });
        if (report?.promptId) {
          await promptCollection.deleteOne({ _id: new ObjectId(report.promptId) });
        }
        const result = await reportCollection.deleteOne({ _id: new ObjectId(id) });
        res.json(result);
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

   app.get("/admin/payments", async (req, res) => {
  try {
    const result = await paymentCollection
      .aggregate([
        { $sort: { createdAt: -1 } },
        {
          $lookup: {
            from: "user",
            localField: "email",
            foreignField: "email",
            as: "userInfo",
          },
        },
        {
          $addFields: {
            purchaserName: { $arrayElemAt: ["$userInfo.name", 0] },
            purchaserId: { $arrayElemAt: ["$userInfo._id", 0] },
          },
        },
        { $project: { userInfo: 0 } },
      ])
      .toArray();

    res.json({ data: result });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

  

    await client.db("admin").command({ ping: 1 });
    console.log("Pinged! Successfully connected to MongoDB!");
  } finally {
    // await client.close();
  }
}

run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Server is running fine!");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});