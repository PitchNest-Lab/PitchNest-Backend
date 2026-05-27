import { Request, Response } from "express";
import { supabase } from "../config/supabase.ts";

export const wipeDb = async (req: Request, res: Response) => {
  try {
    await supabase.from("users").delete().neq("id", 0);
    await supabase.from("sessions").delete().neq("id", 0);
    await supabase.from("decks").delete().neq("id", 0);
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
    const cleanEmail = email.toLowerCase().trim();

    const { data: existingUser } = await supabase
      .from("users")
      .select("*")
      .eq("email", cleanEmail)
      .maybeSingle();

    if (existingUser) return res.status(400).json({ error: "Email exists" });

    const { data: newUser, error } = await supabase
      .from("users")
      .insert([{ name, email: cleanEmail, password }])
      .select()
      .single();

    if (error || !newUser) return res.status(500).json({ error: "Signup failed" });

    res.status(201).json({ id: newUser.id, name: newUser.name, email: newUser.email });
  } catch (error) {
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

    if (error || !user || user.password !== password) {
      return res.status(401).json({ error: "Invalid credentials." });
    }
    res.status(200).json({ id: user.id, name: user.name, email: user.email });
  } catch (error) {
    res.status(500).json({ error: "Login failed" });
  }
};
