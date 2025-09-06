const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI || 'mongodb+srv://arjunjagdalesitsentc_db_user:arjun123@cluster0.92gb2j8.mongodb.net/resumeDB?retryWrites=true&w=majority', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

// User Schema
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  openrouterApiKey: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});

// Query Schema
const querySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  query: { type: String, required: true },
  results: [{ 
    title: String,
    authors: [String],
    summary: String,
    url: String,
    publishedDate: String
  }],
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Query = mongoose.model('Query', querySchema);

// Auth Middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key', (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid token' });
    }
    req.user = user;
    next();
  });
};

// Routes

// Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: 'User already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ email, password: hashedPassword });
    await user.save();

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET || 'your-secret-key');
    res.json({ token, user: { id: user._id, email: user.email } });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET || 'your-secret-key');
    res.json({ 
      token, 
      user: { 
        id: user._id, 
        email: user.email, 
        openrouterApiKey: user.openrouterApiKey 
      } 
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Update OpenRouter API Key
app.put('/api/user/api-key', authenticateToken, async (req, res) => {
  try {
    const { openrouterApiKey } = req.body;
    await User.findByIdAndUpdate(req.user.userId, { openrouterApiKey });
    res.json({ message: 'API key updated successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Search research papers using arXiv API
app.post('/api/search', authenticateToken, async (req, res) => {
  try {
    const { query } = req.body;
    const user = await User.findById(req.user.userId);
    
    if (!user.openrouterApiKey) {
      return res.status(400).json({ error: 'OpenRouter API key required' });
    }

    // // Search arXiv
    // const arxivResponse = await axios.get(`http://export.arxiv.org/api/query`, {
    //   params: {
    //     search_query: `all:${query}`,
    //     start: 0,
    //     max_results: 3,
    //     sortBy: 'submittedDate',
    //     sortOrder: 'descending'
    //   }
    // });
    // Build smarter query
    const searchQuery = `(ti:"${query}" OR abs:"${query}") AND cat:cs.*`;

    const arxivResponse = await axios.get(`http://export.arxiv.org/api/query`, {
      params: {
        search_query: searchQuery,
        start: 0,
        max_results: 3,
        sortBy: 'relevance',
        sortOrder: 'descending'
      }
    });
    // Parse XML response (simplified)
    const papers = [];
    const xml2js = require('xml2js');
    const parser = new xml2js.Parser();
    
    const result = await parser.parseStringPromise(arxivResponse.data);
    const entries = result.feed.entry || [];

    for (let i = 0; i < Math.min(entries.length, 3); i++) {
      const entry = entries[i];
      const paper = {
        title: Array.isArray(entry.title) ? entry.title[0] : entry.title,
        authors: entry.author ? entry.author.map(author => author.name[0]) : [],
        url: entry.id[0],
        publishedDate: entry.published[0],
        abstract: Array.isArray(entry.summary) ? entry.summary[0] : entry.summary
      };

      // Generate summary using OpenRouter
      try {
        const summaryResponse = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
          model: 'anthropic/claude-3-haiku',
          messages: [
            {
              role: 'user',
              content: `Summarize this research paper abstract in 2-3 sentences: ${paper.abstract}`
            }
          ]
        }, {
          headers: {
            'Authorization': `Bearer ${user.openrouterApiKey}`,
            'Content-Type': 'application/json'
          }
        });

        paper.summary = summaryResponse.data.choices[0].message.content;
      } catch (summaryError) {
        paper.summary = paper.abstract ? paper.abstract.substring(0, 200) + '...' : 'Summary unavailable';
      }

      papers.push(paper);
    }

    // Save query to database
    const queryDoc = new Query({
      userId: req.user.userId,
      query,
      results: papers
    });
    await queryDoc.save();

    res.json({ papers });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Get recent queries
app.get('/api/queries', authenticateToken, async (req, res) => {
  try {
    const queries = await Query.find({ userId: req.user.userId })
      .sort({ createdAt: -1 })
      .limit(10);
    res.json(queries);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Chat endpoint
app.post('/api/chat', authenticateToken, async (req, res) => {
  try {
    const { message } = req.body;
    const user = await User.findById(req.user.userId);
    
    if (!user.openrouterApiKey) {
      return res.status(400).json({ error: 'OpenRouter API key required' });
    }

    const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
      model: 'anthropic/claude-3-haiku',
      messages: [
        {
          role: 'system',
          content: 'You are a helpful research assistant. Help users with research-related questions, paper analysis, and academic inquiries.'
        },
        {
          role: 'user',
          content: message
        }
      ]
    }, {
      headers: {
        'Authorization': `Bearer ${user.openrouterApiKey}`,
        'Content-Type': 'application/json'
      }
    });

    res.json({ response: response.data.choices[0].message.content });
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: 'Chat failed' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});