const dns = require("node:dns");
dns.setServers(['1.1.1.1', '1.0.0.1']);

const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const { createRemoteJWKSet, jwtVerify } = require("jose-cjs");
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

const JWKS = createRemoteJWKSet(
  new URL(`${process.env.CLIENT_URL}/api/auth/jwks`)
);

const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  console.log("Incoming Authorization header:", authHeader);

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Unauthorized: Token missing" });
  }

  const token = authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ message: "Unauthorized: Token malformed" });
  }

  try {
    const { payload } = await jwtVerify(token, JWKS);
    req.user = payload;
    console.log(payload);
    next();
  } catch (error) {
    console.error("JWT Verification Error:", error);
    return res.status(401).json({ message: "Unauthorized: Invalid token" });
  }
};

const verifyRole = (allowedRoles) => {
  return (req, res, next) => {
    const user = req.user;
    if (!user || (!allowedRoles.includes(user.role) && user.role !== "admin")) {
      return res.status(403).json({ message: "Forbidden: Access denied" });
    }
    next();
  };
};

async function run() {
  try {
    // await client.connect();
    const db = client.db("aicore");

    const promptCollection = db.collection("prompts");
    const userCollection = db.collection("user");
    const reportCollection = db.collection("reports");
    const bookmarkCollection = db.collection("bookmarks");
    const reviewCollection = db.collection("reviews");
    const copyLogCollection = db.collection("copyLogs");
    const paymentCollection = db.collection("payments");

    // ==========================================
    //  PAYMENT SUCCESS ROUTE
    // ==========================================
    app.get("/api/payment/success", async (req, res) => {
      try {
        const { session_id, email, prompt_id } = req.query;

        if (!session_id || !email) {
          return res.status(400).send("Missing session_id or email");
        }

        const existing = await paymentCollection.findOne({ sessionId: session_id });

        if (!existing) {
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
    //  USER & CREATOR PROMPT MANAGEMENT ROUTES
    // ==========================================
    app.post("/user/prompts", verifyToken, async (req, res) => {
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

    app.get("/user/prompts", verifyToken, async (req, res) => {
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

    app.delete("/user/prompts/:id", verifyToken, async (req, res) => {
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

    app.patch("/user/prompts/:id", verifyToken, async (req, res) => {
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

    app.patch("/prompts/:id/copy", verifyToken, async (req, res) => {
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
        const updatedPrompt = await promptCollection.findOne(
          { _id: new ObjectId(id) },
          { projection: { copyCount: 1 } }
        );
        res.json({
          ...result,
          limitReached: false,
          copyCount: updatedPrompt?.copyCount || 0,
        });
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

    
    app.get("/prompts/featured", async (req, res) => {
      try {
        const featuredPrompts = await promptCollection
          .find({ status: "approved", featured: true })
          .sort({ copyCount: -1 })
          .limit(6)
          .toArray();

        if (featuredPrompts.length < 6) {
          const existingIds = featuredPrompts.map((p) => p._id);
          const remaining = await promptCollection
            .find({
              status: "approved",
              _id: { $nin: existingIds },
            })
            .sort({ copyCount: -1 })
            .limit(6 - featuredPrompts.length)
            .toArray();

          return res.json({ data: [...featuredPrompts, ...remaining] });
        }

        res.json({ data: featuredPrompts });
      } catch (error) {
        console.error("Featured prompts error:", error);
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

    // ==========================================
    //  BOOKMARK ROUTES
    // ==========================================
    app.post("/bookmarks/toggle", verifyToken, async (req, res) => {
      try {
        const { email, promptId } = req.body;
        if (!email || !promptId) {
          return res.status(400).json({ message: "Email and promptId are required" });
        }

        const existing = await bookmarkCollection.findOne({
          email,
          promptId: promptId.toString(),
        });

        if (existing) {
          await bookmarkCollection.deleteOne({ _id: existing._id });
          await promptCollection.updateOne(
            { _id: new ObjectId(promptId) },
            { $inc: { bookmarkCount: -1 } }
          );
          const updatedPrompt = await promptCollection.findOne({ _id: new ObjectId(promptId) });
          const currentCount = updatedPrompt?.bookmarkCount || 0;
          return res.json({
            bookmarked: false,
            bookmarkCount: currentCount < 0 ? 0 : currentCount,
          });
        }

        await bookmarkCollection.insertOne({
          email,
          promptId: promptId.toString(),
          createdAt: new Date(),
        });
        await promptCollection.updateOne(
          { _id: new ObjectId(promptId) },
          { $inc: { bookmarkCount: 1 } }
        );
        const updatedPrompt = await promptCollection.findOne({ _id: new ObjectId(promptId) });
        return res.json({
          bookmarked: true,
          bookmarkCount: updatedPrompt?.bookmarkCount || 1,
        });
      } catch (error) {
        console.error("Bookmark toggle error:", error);
        res.status(500).json({ message: "Internal server error during toggle" });
      }
    });

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

    app.get("/bookmarks", verifyToken, async (req, res) => {
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

    // ==========================================
    //  REVIEW ROUTES
    // ==========================================
    app.post("/reviews", verifyToken, async (req, res) => {
      try {
        const { promptId, name, email, rating, comment, aiTool } = req.body;

        if (!promptId || !rating) {
          return res.status(400).json({ message: "promptId and rating are required" });
        }

        // ✅ Rating range validation (1-5 only, whole number)
        const numRating = Number(rating);
        if (!Number.isInteger(numRating) || numRating < 1 || numRating > 5) {
          return res.status(400).json({ message: "Rating must be a whole number between 1 and 5" });
        }

        // ✅ Junk/empty comment validation
        if (!comment || comment.trim().length < 5) {
          return res.status(400).json({ message: "Review comment must be at least 5 characters" });
        }

        // ✅ Duplicate check — same email same promptId e ekbar e review
        const existingReview = await reviewCollection.findOne({ promptId, email });
        if (existingReview) {
          return res.status(409).json({ message: "You have already reviewed this prompt" });
        }

        await reviewCollection.insertOne({
          promptId,
          name,
          email,
          rating: numRating,
          comment: comment.trim(),
          aiTool,
          createdAt: new Date(),
        });

        const allReviews = await reviewCollection.find({ promptId }).toArray();
        const avg = allReviews.reduce((sum, r) => sum + r.rating, 0) / allReviews.length;

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

    // review
    app.get("/reviews/public", async (req, res) => {
      try {
        const reviews = await reviewCollection
          .find({})
          .sort({ createdAt: -1 })
          .limit(6)
          .toArray();

        const promptIds = reviews
          .filter((r) => r.promptId)
          .map((r) => new ObjectId(r.promptId));

        const prompts = promptIds.length
          ? await promptCollection
              .find({ _id: { $in: promptIds } })
              .project({ title: 1 })
              .toArray()
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
        console.error("Public reviews error:", error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    app.get("/reviews", verifyToken, async (req, res) => {
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

    // ==========================================
    //  REPORT ROUTES
    // ==========================================
    app.post("/reports", verifyToken, async (req, res) => {
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

    // ==========================================
    //  PAYMENT ROUTES
    // ==========================================
    app.post("/payments/confirm", verifyToken, async (req, res) => {
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

    // ==========================================
    //  CREATOR ROUTES
    // ==========================================
    app.get("/api/creator/analytics", verifyToken, verifyRole(["creator", "admin"]), async (req, res) => {
      try {
        const { email } = req.query;
        if (!email) {
          return res.status(400).json({ message: "Email is required" });
        }

        const creatorPrompts = await promptCollection.find({
          $or: [{ email: email }, { creatorEmail: email }],
        }).toArray();
        const totalPrompts = creatorPrompts.length;

        let totalCopies = 0;
        const promptIdsStr = creatorPrompts.map((p) => p._id.toString());

        creatorPrompts.forEach((p) => {
          totalCopies += p.copyCount || 0;
        });

        const bookmarkMap = {};
        let totalBookmarks = 0;

        if (promptIdsStr.length > 0) {
          const bookmarkCounts = await bookmarkCollection.aggregate([
            { $match: { promptId: { $in: promptIdsStr } } },
            { $group: { _id: "$promptId", count: { $sum: 1 } } },
          ]).toArray();

          bookmarkCounts.forEach((b) => {
            if (b._id) {
              bookmarkMap[b._id.toString()] = b.count;
              totalBookmarks += b.count;
            }
          });
        }

        const barData = creatorPrompts.map((p) => {
          const idStr = p._id.toString();
          return {
            name: p.title.length > 12 ? p.title.substring(0, 12) + "..." : p.title,
            Bookmarks: bookmarkMap[idStr] || 0,
            Copies: p.copyCount || 0,
          };
        });

        const promptDayCounts = {};
        creatorPrompts.forEach((p) => {
          const day = new Date(p.createdAt).toISOString().split("T")[0];
          promptDayCounts[day] = (promptDayCounts[day] || 0) + 1;
        });

        const copyDayCounts = {};
        if (promptIdsStr.length > 0) {
          const copyLogs = await copyLogCollection
            .find({ promptId: { $in: promptIdsStr } })
            .toArray();
          copyLogs.forEach((c) => {
            const day = new Date(c.createdAt).toISOString().split("T")[0];
            copyDayCounts[day] = (copyDayCounts[day] || 0) + 1;
          });
        }

        const allDays = Array.from(
          new Set([...Object.keys(promptDayCounts), ...Object.keys(copyDayCounts)])
        ).sort();

        let runningPrompts = 0;
        let runningCopies = 0;
        let lineData = allDays.map((day) => {
          runningPrompts += promptDayCounts[day] || 0;
          runningCopies += copyDayCounts[day] || 0;
          return {
            name: day,
            "Total Copies": runningCopies,
            "Total Prompts": runningPrompts,
          };
        });

        if (lineData.length === 0 && totalPrompts > 0) {
          const todayStr = new Date().toISOString().split("T")[0];
          lineData = [{ name: todayStr, "Total Copies": totalCopies, "Total Prompts": totalPrompts }];
        }

        res.json({ stats: { totalPrompts, totalCopies, totalBookmarks }, barData, lineData });
      } catch (error) {
        console.error("Creator analytics error:", error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // token
    app.get("/creators/top", async (req, res) => {
      try {
        const creators = await userCollection
          .find({ role: "creator" })
          .project({ name: 1, email: 1, image: 1, role: 1 })
          .toArray();

        const creatorsWithStats = await Promise.all(
          creators.map(async (creator) => {
            const creatorPrompts = await promptCollection
              .find({ email: creator.email, status: "approved" })
              .project({ copyCount: 1 })
              .toArray();

            const templatesCount = creatorPrompts.length;
            const copyCount = creatorPrompts.reduce(
              (sum, p) => sum + (p.copyCount || 0),
              0
            );

            return { ...creator, templatesCount, copyCount };
          })
        );

        creatorsWithStats.sort((a, b) => b.copyCount - a.copyCount);
        res.json({ data: creatorsWithStats.slice(0, 6) });
      } catch (error) {
        console.error("Top creators error:", error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // ==========================================
    //  ADMIN MANAGEMENT ROUTES (ADMIN ONLY)
    // ==========================================
    app.get("/admin/analytics", verifyToken, verifyRole(["admin"]), async (req, res) => {
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

        res.json({ totalUsers, totalPrompts, totalReviews, totalCopies, totalRevenue, engineBreakdown });
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    app.get("/admin/users", verifyToken, verifyRole(["admin"]), async (req, res) => {
      try {
        const { page = 1, limit = 10 } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);

        const total = await userCollection.countDocuments({});
        const result = await userCollection
          .find({})
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(parseInt(limit))
          .toArray();

        res.json({ data: result, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) });
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    app.patch("/admin/users/:id/role", verifyToken, verifyRole(["admin"]), async (req, res) => {
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

    app.delete("/admin/users/:id", verifyToken, verifyRole(["admin"]), async (req, res) => {
      try {
        const { id } = req.params;
        const result = await userCollection.deleteOne({ _id: new ObjectId(id) });
        res.json(result);
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    app.get("/admin/prompts", verifyToken, verifyRole(["admin"]), async (req, res) => {
      try {
        const result = await promptCollection.find({}).sort({ createdAt: -1 }).toArray();
        const total = await promptCollection.countDocuments({});
        res.json({ data: result, total });
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    app.patch("/admin/prompts/:id/status", verifyToken, verifyRole(["admin"]), async (req, res) => {
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

    app.delete("/admin/prompts/:id", verifyToken, verifyRole(["admin"]), async (req, res) => {
      try {
        const { id } = req.params;
        const result = await promptCollection.deleteOne({ _id: new ObjectId(id) });
        res.json(result);
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    app.patch("/admin/prompts/:id/feature", verifyToken, verifyRole(["admin"]), async (req, res) => {
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

    app.get("/admin/reports", verifyToken, verifyRole(["admin"]), async (req, res) => {
      try {
        const result = await reportCollection.find({}).sort({ createdAt: -1 }).toArray();
        res.json({ data: result });
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    app.patch("/admin/reports/:id/dismiss", verifyToken, verifyRole(["admin"]), async (req, res) => {
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

    app.patch("/admin/reports/:id/warn", verifyToken, verifyRole(["admin"]), async (req, res) => {
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

    app.delete("/admin/reports/:id/remove-prompt", verifyToken, verifyRole(["admin"]), async (req, res) => {
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

    app.get("/admin/payments", verifyToken, verifyRole(["admin"]), async (req, res) => {
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