/**
 * The country table the quiz duels ask about.
 *
 * Offline by construction. AirLink runs with no network at all, so a trivia
 * game cannot fetch a question bank; the bank ships in the binary or it does
 * not exist. A hundred rows of five short fields cost a few kilobytes, which is
 * nothing beside the app, and they never go stale mid-match.
 *
 * The table is deliberately flat and dumb: no indices, no lookup maps, no
 * derived groupings. Every consumer wants a different slice of it - by region,
 * by area, by code - and building those indices here would have meant guessing
 * which slices matter. Callers filter the array; at this size that is a few
 * microseconds and the code stays obvious.
 *
 * Flags are stored as the finished emoji rather than derived from the code at
 * runtime. Deriving them is two regional-indicator code points and would have
 * been shorter, but a literal is greppable, is visible in a diff, and cannot be
 * broken by an engine that renders the pair as two letters.
 *
 * Areas are total area in square kilometres, rounded to the whole kilometre as
 * published; they are used only for "which is larger", so what matters is that
 * the ORDER is right, and no two rows are close enough for a rounding argument.
 * Names are the short English forms a player would say out loud, and capitals
 * are the seat a quiz expects: Pretoria for South Africa, Amsterdam for the
 * Netherlands, Bern for Switzerland. Countries whose capital is genuinely
 * disputed or split are left out rather than argued about.
 */

export type Region = 'Europe' | 'Asia' | 'Africa' | 'North America' | 'South America' | 'Oceania';

export interface Country {
  readonly name: string;
  readonly capital: string;
  /** ISO 3166-1 alpha-2. Unique, and short enough to be a natural key. */
  readonly code: string;
  readonly flag: string;
  readonly region: Region;
  /** Total area in square kilometres. */
  readonly areaKm2: number;
}

export const COUNTRIES: readonly Country[] = [
  { name: 'France', capital: 'Paris', code: 'FR', flag: '🇫🇷', region: 'Europe', areaKm2: 551695 },
  { name: 'Germany', capital: 'Berlin', code: 'DE', flag: '🇩🇪', region: 'Europe', areaKm2: 357022 },
  { name: 'Spain', capital: 'Madrid', code: 'ES', flag: '🇪🇸', region: 'Europe', areaKm2: 505990 },
  { name: 'Italy', capital: 'Rome', code: 'IT', flag: '🇮🇹', region: 'Europe', areaKm2: 301340 },
  { name: 'Portugal', capital: 'Lisbon', code: 'PT', flag: '🇵🇹', region: 'Europe', areaKm2: 92090 },
  { name: 'Poland', capital: 'Warsaw', code: 'PL', flag: '🇵🇱', region: 'Europe', areaKm2: 312685 },
  { name: 'Sweden', capital: 'Stockholm', code: 'SE', flag: '🇸🇪', region: 'Europe', areaKm2: 450295 },
  { name: 'Norway', capital: 'Oslo', code: 'NO', flag: '🇳🇴', region: 'Europe', areaKm2: 385207 },
  { name: 'Finland', capital: 'Helsinki', code: 'FI', flag: '🇫🇮', region: 'Europe', areaKm2: 338424 },
  { name: 'Denmark', capital: 'Copenhagen', code: 'DK', flag: '🇩🇰', region: 'Europe', areaKm2: 43094 },
  { name: 'Netherlands', capital: 'Amsterdam', code: 'NL', flag: '🇳🇱', region: 'Europe', areaKm2: 41850 },
  { name: 'Belgium', capital: 'Brussels', code: 'BE', flag: '🇧🇪', region: 'Europe', areaKm2: 30528 },
  { name: 'Austria', capital: 'Vienna', code: 'AT', flag: '🇦🇹', region: 'Europe', areaKm2: 83879 },
  { name: 'Switzerland', capital: 'Bern', code: 'CH', flag: '🇨🇭', region: 'Europe', areaKm2: 41285 },
  { name: 'Greece', capital: 'Athens', code: 'GR', flag: '🇬🇷', region: 'Europe', areaKm2: 131957 },
  { name: 'Ireland', capital: 'Dublin', code: 'IE', flag: '🇮🇪', region: 'Europe', areaKm2: 70273 },
  { name: 'Czechia', capital: 'Prague', code: 'CZ', flag: '🇨🇿', region: 'Europe', areaKm2: 78867 },
  { name: 'Hungary', capital: 'Budapest', code: 'HU', flag: '🇭🇺', region: 'Europe', areaKm2: 93028 },
  { name: 'Romania', capital: 'Bucharest', code: 'RO', flag: '🇷🇴', region: 'Europe', areaKm2: 238397 },
  { name: 'Ukraine', capital: 'Kyiv', code: 'UA', flag: '🇺🇦', region: 'Europe', areaKm2: 603500 },
  { name: 'Croatia', capital: 'Zagreb', code: 'HR', flag: '🇭🇷', region: 'Europe', areaKm2: 56594 },
  { name: 'Iceland', capital: 'Reykjavík', code: 'IS', flag: '🇮🇸', region: 'Europe', areaKm2: 103000 },
  { name: 'United Kingdom', capital: 'London', code: 'GB', flag: '🇬🇧', region: 'Europe', areaKm2: 243610 },
  { name: 'Bulgaria', capital: 'Sofia', code: 'BG', flag: '🇧🇬', region: 'Europe', areaKm2: 110879 },
  { name: 'Japan', capital: 'Tokyo', code: 'JP', flag: '🇯🇵', region: 'Asia', areaKm2: 377975 },
  { name: 'China', capital: 'Beijing', code: 'CN', flag: '🇨🇳', region: 'Asia', areaKm2: 9596961 },
  { name: 'India', capital: 'New Delhi', code: 'IN', flag: '🇮🇳', region: 'Asia', areaKm2: 3287263 },
  { name: 'South Korea', capital: 'Seoul', code: 'KR', flag: '🇰🇷', region: 'Asia', areaKm2: 100210 },
  { name: 'Thailand', capital: 'Bangkok', code: 'TH', flag: '🇹🇭', region: 'Asia', areaKm2: 513120 },
  { name: 'Vietnam', capital: 'Hanoi', code: 'VN', flag: '🇻🇳', region: 'Asia', areaKm2: 331212 },
  { name: 'Indonesia', capital: 'Jakarta', code: 'ID', flag: '🇮🇩', region: 'Asia', areaKm2: 1904569 },
  { name: 'Malaysia', capital: 'Kuala Lumpur', code: 'MY', flag: '🇲🇾', region: 'Asia', areaKm2: 330803 },
  { name: 'Philippines', capital: 'Manila', code: 'PH', flag: '🇵🇭', region: 'Asia', areaKm2: 300000 },
  { name: 'Pakistan', capital: 'Islamabad', code: 'PK', flag: '🇵🇰', region: 'Asia', areaKm2: 881913 },
  { name: 'Bangladesh', capital: 'Dhaka', code: 'BD', flag: '🇧🇩', region: 'Asia', areaKm2: 147570 },
  { name: 'Nepal', capital: 'Kathmandu', code: 'NP', flag: '🇳🇵', region: 'Asia', areaKm2: 147181 },
  { name: 'Mongolia', capital: 'Ulaanbaatar', code: 'MN', flag: '🇲🇳', region: 'Asia', areaKm2: 1564110 },
  { name: 'Kazakhstan', capital: 'Astana', code: 'KZ', flag: '🇰🇿', region: 'Asia', areaKm2: 2724900 },
  { name: 'Saudi Arabia', capital: 'Riyadh', code: 'SA', flag: '🇸🇦', region: 'Asia', areaKm2: 2149690 },
  { name: 'Iran', capital: 'Tehran', code: 'IR', flag: '🇮🇷', region: 'Asia', areaKm2: 1648195 },
  { name: 'Iraq', capital: 'Baghdad', code: 'IQ', flag: '🇮🇶', region: 'Asia', areaKm2: 438317 },
  { name: 'Turkey', capital: 'Ankara', code: 'TR', flag: '🇹🇷', region: 'Asia', areaKm2: 783562 },
  { name: 'Jordan', capital: 'Amman', code: 'JO', flag: '🇯🇴', region: 'Asia', areaKm2: 89342 },
  { name: 'Uzbekistan', capital: 'Tashkent', code: 'UZ', flag: '🇺🇿', region: 'Asia', areaKm2: 448969 },
  { name: 'Egypt', capital: 'Cairo', code: 'EG', flag: '🇪🇬', region: 'Africa', areaKm2: 1001450 },
  { name: 'Nigeria', capital: 'Abuja', code: 'NG', flag: '🇳🇬', region: 'Africa', areaKm2: 923768 },
  { name: 'Kenya', capital: 'Nairobi', code: 'KE', flag: '🇰🇪', region: 'Africa', areaKm2: 580367 },
  { name: 'Ethiopia', capital: 'Addis Ababa', code: 'ET', flag: '🇪🇹', region: 'Africa', areaKm2: 1104300 },
  { name: 'South Africa', capital: 'Pretoria', code: 'ZA', flag: '🇿🇦', region: 'Africa', areaKm2: 1221037 },
  { name: 'Morocco', capital: 'Rabat', code: 'MA', flag: '🇲🇦', region: 'Africa', areaKm2: 446550 },
  { name: 'Algeria', capital: 'Algiers', code: 'DZ', flag: '🇩🇿', region: 'Africa', areaKm2: 2381741 },
  { name: 'Tunisia', capital: 'Tunis', code: 'TN', flag: '🇹🇳', region: 'Africa', areaKm2: 163610 },
  { name: 'Ghana', capital: 'Accra', code: 'GH', flag: '🇬🇭', region: 'Africa', areaKm2: 238533 },
  { name: 'Senegal', capital: 'Dakar', code: 'SN', flag: '🇸🇳', region: 'Africa', areaKm2: 196722 },
  { name: 'Tanzania', capital: 'Dodoma', code: 'TZ', flag: '🇹🇿', region: 'Africa', areaKm2: 947303 },
  { name: 'Uganda', capital: 'Kampala', code: 'UG', flag: '🇺🇬', region: 'Africa', areaKm2: 241550 },
  { name: 'Zimbabwe', capital: 'Harare', code: 'ZW', flag: '🇿🇼', region: 'Africa', areaKm2: 390757 },
  { name: 'Zambia', capital: 'Lusaka', code: 'ZM', flag: '🇿🇲', region: 'Africa', areaKm2: 752618 },
  { name: 'Namibia', capital: 'Windhoek', code: 'NA', flag: '🇳🇦', region: 'Africa', areaKm2: 825615 },
  { name: 'Botswana', capital: 'Gaborone', code: 'BW', flag: '🇧🇼', region: 'Africa', areaKm2: 581730 },
  { name: 'Mozambique', capital: 'Maputo', code: 'MZ', flag: '🇲🇿', region: 'Africa', areaKm2: 801590 },
  { name: 'Angola', capital: 'Luanda', code: 'AO', flag: '🇦🇴', region: 'Africa', areaKm2: 1246700 },
  { name: 'Cameroon', capital: 'Yaoundé', code: 'CM', flag: '🇨🇲', region: 'Africa', areaKm2: 475442 },
  { name: 'Madagascar', capital: 'Antananarivo', code: 'MG', flag: '🇲🇬', region: 'Africa', areaKm2: 587041 },
  { name: 'United States', capital: 'Washington, D.C.', code: 'US', flag: '🇺🇸', region: 'North America', areaKm2: 9833517 },
  { name: 'Canada', capital: 'Ottawa', code: 'CA', flag: '🇨🇦', region: 'North America', areaKm2: 9984670 },
  { name: 'Mexico', capital: 'Mexico City', code: 'MX', flag: '🇲🇽', region: 'North America', areaKm2: 1964375 },
  { name: 'Cuba', capital: 'Havana', code: 'CU', flag: '🇨🇺', region: 'North America', areaKm2: 109884 },
  { name: 'Jamaica', capital: 'Kingston', code: 'JM', flag: '🇯🇲', region: 'North America', areaKm2: 10991 },
  { name: 'Guatemala', capital: 'Guatemala City', code: 'GT', flag: '🇬🇹', region: 'North America', areaKm2: 108889 },
  { name: 'Costa Rica', capital: 'San José', code: 'CR', flag: '🇨🇷', region: 'North America', areaKm2: 51100 },
  { name: 'Panama', capital: 'Panama City', code: 'PA', flag: '🇵🇦', region: 'North America', areaKm2: 75417 },
  { name: 'Honduras', capital: 'Tegucigalpa', code: 'HN', flag: '🇭🇳', region: 'North America', areaKm2: 112492 },
  { name: 'Nicaragua', capital: 'Managua', code: 'NI', flag: '🇳🇮', region: 'North America', areaKm2: 130373 },
  { name: 'Dominican Republic', capital: 'Santo Domingo', code: 'DO', flag: '🇩🇴', region: 'North America', areaKm2: 48671 },
  { name: 'Haiti', capital: 'Port-au-Prince', code: 'HT', flag: '🇭🇹', region: 'North America', areaKm2: 27750 },
  { name: 'Belize', capital: 'Belmopan', code: 'BZ', flag: '🇧🇿', region: 'North America', areaKm2: 22966 },
  { name: 'El Salvador', capital: 'San Salvador', code: 'SV', flag: '🇸🇻', region: 'North America', areaKm2: 21041 },
  { name: 'Brazil', capital: 'Brasília', code: 'BR', flag: '🇧🇷', region: 'South America', areaKm2: 8515767 },
  { name: 'Argentina', capital: 'Buenos Aires', code: 'AR', flag: '🇦🇷', region: 'South America', areaKm2: 2780400 },
  { name: 'Chile', capital: 'Santiago', code: 'CL', flag: '🇨🇱', region: 'South America', areaKm2: 756102 },
  { name: 'Peru', capital: 'Lima', code: 'PE', flag: '🇵🇪', region: 'South America', areaKm2: 1285216 },
  { name: 'Colombia', capital: 'Bogotá', code: 'CO', flag: '🇨🇴', region: 'South America', areaKm2: 1141748 },
  { name: 'Venezuela', capital: 'Caracas', code: 'VE', flag: '🇻🇪', region: 'South America', areaKm2: 916445 },
  { name: 'Ecuador', capital: 'Quito', code: 'EC', flag: '🇪🇨', region: 'South America', areaKm2: 283561 },
  { name: 'Uruguay', capital: 'Montevideo', code: 'UY', flag: '🇺🇾', region: 'South America', areaKm2: 176215 },
  { name: 'Paraguay', capital: 'Asunción', code: 'PY', flag: '🇵🇾', region: 'South America', areaKm2: 406752 },
  { name: 'Guyana', capital: 'Georgetown', code: 'GY', flag: '🇬🇾', region: 'South America', areaKm2: 214969 },
  { name: 'Suriname', capital: 'Paramaribo', code: 'SR', flag: '🇸🇷', region: 'South America', areaKm2: 163820 },
  { name: 'Australia', capital: 'Canberra', code: 'AU', flag: '🇦🇺', region: 'Oceania', areaKm2: 7692024 },
  { name: 'New Zealand', capital: 'Wellington', code: 'NZ', flag: '🇳🇿', region: 'Oceania', areaKm2: 268021 },
  { name: 'Papua New Guinea', capital: 'Port Moresby', code: 'PG', flag: '🇵🇬', region: 'Oceania', areaKm2: 462840 },
  { name: 'Fiji', capital: 'Suva', code: 'FJ', flag: '🇫🇯', region: 'Oceania', areaKm2: 18274 },
  { name: 'Solomon Islands', capital: 'Honiara', code: 'SB', flag: '🇸🇧', region: 'Oceania', areaKm2: 28896 },
  { name: 'Vanuatu', capital: 'Port Vila', code: 'VU', flag: '🇻🇺', region: 'Oceania', areaKm2: 12189 },
  { name: 'Samoa', capital: 'Apia', code: 'WS', flag: '🇼🇸', region: 'Oceania', areaKm2: 2842 },
  { name: 'Tonga', capital: "Nuku'alofa", code: 'TO', flag: '🇹🇴', region: 'Oceania', areaKm2: 747 },
  { name: 'Kiribati', capital: 'Tarawa', code: 'KI', flag: '🇰🇮', region: 'Oceania', areaKm2: 811 },
  { name: 'Palau', capital: 'Ngerulmud', code: 'PW', flag: '🇵🇼', region: 'Oceania', areaKm2: 459 },
];
