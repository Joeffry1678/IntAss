// src/core/config.js
function getConfig() {
  return {
    supabase: {
      url: process.env.SUPABASE_URL || "https://fzblccvtvmyhmqjamchu.supabase.co",
      anonKey: process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ6YmxjY3Z0dm15aG1xamFtY2h1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3NTMyNDgsImV4cCI6MjA4NjMyOTI0OH0.uvYjIPOC5NkiTd7ByNmaERh0GqdYYE7hpXrrBe2-33o"
    }
  };
}
module.exports = { getConfig };

//from main.js before
//const SUPABASE_URL = "https://fzblccvtvmyhmqjamchu.supabase.co";
//const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ6YmxjY3Z0dm15aG1xamFtY2h1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3NTMyNDgsImV4cCI6MjA4NjMyOTI0OH0.uvYjIPOC5NkiTd7ByNmaERh0GqdYYE7hpXrrBe2-33o";
