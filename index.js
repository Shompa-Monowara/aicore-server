const dns = require('node:dns');
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
    strict: true,
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

    //  PROMPT ROUTES
    // Add prompt
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

    // Get prompts (with optional email filter)
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

    // Delete prompt
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

    // Update prompt
    app.patch("/user/prompts/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const data = req.body;
        const result = await promptCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { ...data, updatedAt: new Date() } }
        );
        res.json(result);
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    
    // All Public Prompts — search + filter + sort + pagination
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

        const query = {};

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

    // Get single prompt by ID
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

    // Increase copy count
    app.patch("/prompts/:id/copy", async (req, res) => {
      try {
        const { id } = req.params;
        const result = await promptCollection.updateOne(
          { _id: new ObjectId(id) },
          { $inc: { copyCount: 1 } }
        );
        res.json(result);
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // ADMIN ROUTES 

    // Admin Analytics
    app.get("/admin/analytics", async (req, res) => {
      try {
        const totalPrompts = await promptCollection.countDocuments({});
        const totalUsers = await userCollection.countDocuments({});

        const copyCountAgg = await promptCollection
          .aggregate([
            { $group: { _id: null, total: { $sum: "$copyCount" } } },
          ])
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

        res.json({
          totalUsers,
          totalPrompts,
          totalReviews: 0,
          totalCopies,
          totalRevenue: 0,
          engineBreakdown,
        });
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // Get all users
    app.get("/admin/users", async (req, res) => {
      try {
        const result = await userCollection
          .find({})
          .sort({ createdAt: -1 })
          .toArray();
        res.json({ data: result });
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // Update user role
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

    // Delete user
    app.delete("/admin/users/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const result = await userCollection.deleteOne({
          _id: new ObjectId(id),
        });
        res.json(result);
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // Get all prompts (admin)
    app.get("/admin/prompts", async (req, res) => {
      try {
        const result = await promptCollection
          .find({})
          .sort({ createdAt: -1 })
          .toArray();
        const total = await promptCollection.countDocuments({});
        res.json({ data: result, total });
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // Approve / Reject prompt (admin)
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

    // Delete prompt (admin)
    app.delete("/admin/prompts/:id", async (req, res) => {
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

    // Feature prompt (admin)
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

    //Get all reported prompts
    app.get("/admin/reports", async (req, res) => {
      try {
        const result = await reportCollection
          .find({})
          .sort({ createdAt: -1 })
          .toArray();
        res.json({ data: result });
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    //  Dismiss report (not harmful)
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

    //  Warn creator
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

    //  Remove reported prompt — prompt + report দুটোই delete করে
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

    // PING 
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