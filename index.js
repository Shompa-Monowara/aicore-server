const dns = require('node:dns');
dns.setServers(['1.1.1.1', '1.0.0.1']); 

const express = require("express");
const dontenv = require("dotenv");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
dontenv.config();

const uri = process.env.MONGODB_URI;

const app = express();
const PORT = process.env.PORT;

app.use(
  cors({
    credentials: true,
    origin: [process.env.CLIENT_URL],
  }),
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

  
    app.post("/user/prompts", async (req, res) => {
      try {
        const data = req.body;
        const result = await promptCollection.insertOne({
          ...data,
          createdAt: new Date()
        });
        res.json(result);
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

  
    app.get("/user/prompts", async (req, res) => {
      try {
        const { email } = req.query; // 
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
        const result = await promptCollection.deleteOne({ _id: new ObjectId(id) });
        res.json(result);
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    //  Admin Analytics — aggregate endpoint
    app.get("/admin/analytics", async (req, res) => {
      try {
        const totalPrompts = await promptCollection.countDocuments({});

        // better-auth ডিফল্টে "user" নামের collection বানায় same DB তে
        const userCollection = db.collection("user");
        const totalUsers = await userCollection.countDocuments({});

        const copyCountAgg = await promptCollection.aggregate([
          { $group: { _id: null, total: { $sum: "$copyCount" } } },
        ]).toArray();
        const totalCopies = copyCountAgg[0]?.total || 0;

        const engineBreakdown = await promptCollection.aggregate([
          {
            $group: {
              _id: "$aiTool",
              promptsCount: { $sum: 1 },
              totalCopies: { $sum: "$copyCount" },
            },
          },
        ]).toArray();

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

    // 🎯 All Users — list সব user
app.get("/admin/users", async (req, res) => {
  try {
    const userCollection = db.collection("user");
    const result = await userCollection.find({}).sort({ createdAt: -1 }).toArray();
    res.json({ data: result });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// 🎯 Role update
app.patch("/admin/users/:id/role", async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;
    const userCollection = db.collection("user");
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

// 🎯 All Users — list সব user
app.get("/admin/users", async (req, res) => {
  try {
    const userCollection = db.collection("user");
    const result = await userCollection.find({}).sort({ createdAt: -1 }).toArray();
    res.json({ data: result });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Role update
app.patch("/admin/users/:id/role", async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;
    const userCollection = db.collection("user");
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

//  Delete user
app.delete("/admin/users/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const userCollection = db.collection("user");
    const result = await userCollection.deleteOne({ _id: new ObjectId(id) });
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // Ensures that the client will close when you finish/error
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