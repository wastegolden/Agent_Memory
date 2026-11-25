export interface PersonaCard { text: string; version: string }
export interface PersonaHost { read(): PersonaCard; save(text: string): PersonaCard }
