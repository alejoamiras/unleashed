import "@unleashed/design/base.css"
import "./styles/landing.css"
import { COPY } from "./content.ts"
import { FACES, fontsLoaded } from "./fonts.ts"

// The wordmark's converge animation only reads on its own face (landing.css gates it on this class).
fontsLoaded([FACES.pixel], COPY.brand).then(() => document.documentElement.classList.add("fonts-ready"))
