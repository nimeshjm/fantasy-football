# Fantasy Liga Portugal Betclic Agent

## Overview
This is an autonomous agent that manages a Fantasy Liga Portugal Betclic team entirely on Cloudflare's free tier using Workers and D1 database. The agent uses LLM (Workers AI) for decision-making with a deterministic optimizer as fallback.

## Architecture

### Core Components
- **Ingest Workflow**: Pulls gameweek data from API endpoints into D1 database
- **DecideCommit Workflow**: Makes squad/transfer/lineup decisions and commits them
- **D1 Database**: Stores teams, players, fixtures, statistics, and projections
- **AI Decision Making**: Uses Workers AI with deterministic fallback

### Database Schema
The system uses a SQLite-based D1 database with these key tables:
- **events**: Gameweek tracking
- **teams**: Team information
- **elements**: Player data including stats
- **element_gw_stats**: Player performance in fixtures
- **fixtures**: Fixture matchups and scores
- **team_ratings**: Team attack/defence ratings (fitted from actual results)
- **projections**: Player performance projections
- **squad_state**: Current team lineup and transfer status
- **config**: System configuration

### Data Flow

#### Ingest Workflow (`src/workflows/ingest.ts`)
1. Fetches live data for each gameweek (players' stats and fixtures)
2. Converts to structured rows for database insertion
3. Upserts player stats and fixture data into D1
4. **Key Integration**: Refits team ratings from played fixtures using `fitTeamRatings` function

#### Team Ratings Model (`src/model/ratings.ts`)
- Implements a Poisson-style attack/defence model
- Fits ratings from finished fixture scorelines rather than API estimates
- Uses ridge regularization to prevent overfitting with limited data
- Stores both per-team ratings and league-wide scalars in config table

#### Decision-Commit Workflow (`src/workflows/decideCommit.ts`)
- Makes squad/transfer/lineup decisions using both AI and deterministic approaches
- Uses team ratings for fixture difficulty information in projections

### Implementation Details
- **Chunked Operations**: D1 has a limit of 100 bound parameters per statement, requiring chunked upserts
- **CPU Budgeting**: Workflow steps are split to stay within 10ms CPU budget per step
- **Data Types**: Boolean values stored as INTEGER 0/1 in SQLite, coerced back to real booleans in src/db
- **Timestamps**: Stored as ISO 8601 TEXT format

### Key Features
- **Autonomous Operation**: Runs entirely on Cloudflare free tier
- **Data-Driven Decisions**: Uses actual fixture results to fit team ratings
- **Hybrid AI Approach**: LLM decision making with deterministic fallback
- **Cron-Based Workflow**: Hourly triggers for regular processing