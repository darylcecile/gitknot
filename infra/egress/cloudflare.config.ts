import { defineConfig } from 'cf/config';
import { configuration } from '../cloudflare.ts';

export default defineConfig(({ mode }) => configuration('egress', mode));
