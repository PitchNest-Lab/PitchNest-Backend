import { Request, Response } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { supabase } from "../config/supabase.ts";
import { config } from "../config/env.ts";

const BCRYPT_ROUNDS = 12;

/**
 * Signs a JWT token for the given user.
 */
function signToken(user: { id: number; email: string }): string {
  return jwt.sign(
    { id: user.id, email: user.email },
    config.jwtSecret,
    { expiresIn: "7d" }
  );
}

export const wipeDb = async (req: Request, res: Response) => {
  try {
    await supabase.from("users").delete().neq("id", 0);
    await supabase.from("sessions").delete().neq("id", 0);
    await supabase.from("decks").delete().neq("id", 0);
    await supabase.from("profiles").delete().neq("id", 0);
    res.status(200).send("<h1>Database wiped</h1>");
  } catch (e) {
    res.status(500).json({ error: "Error wiping database." });
  }
};

export const signup = async (req: Request, res: Response) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: "Name, email, and password are required." });
    }

    if (name.trim().length < 2) {
      return res.status(400).json({ error: "Name must be at least 2 characters." });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: "Please enter a valid email address." });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters." });
    }
    const cleanEmail = email.toLowerCase().trim();

    const { data: existingUser } = await supabase
      .from("users")
      .select("*")
      .eq("email", cleanEmail)
      .maybeSingle();

    if (existingUser) return res.status(400).json({ error: "Email exists" });

    // Hash password before storing
    const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const { data: newUser, error } = await supabase
      .from("users")
      .insert([{ name, email: cleanEmail, password: hashedPassword }])
      .select()
      .single();

    if (error || !newUser) return res.status(500).json({ error: "Signup failed" });

    const token = signToken({ id: newUser.id, email: newUser.email });

    res.status(201).json({
      user: { id: newUser.id, name: newUser.name, email: newUser.email },
      token
    });
  } catch (error) {
    console.error("Signup error:", error);
    res.status(500).json({ error: "Signup failed" });
  }
};

export const login = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required." });
    }
    const cleanEmail = email.toLowerCase().trim();

    const { data: user, error } = await supabase
      .from("users")
      .select("*")
      .eq("email", cleanEmail)
      .maybeSingle();

    if (error || !user) {
      return res.status(401).json({ error: "Invalid credentials." });
    }

    // Compare hashed password
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ error: "Invalid credentials." });
    }

    const token = signToken({ id: user.id, email: user.email });

    res.status(200).json({
      user: { id: user.id, name: user.name, email: user.email },
      token
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Login failed" });
  }
};
