import React from 'react';

// Иконки наших категорий — свои, нарисованные здесь, а не взятые с
// чужих сайтов: не тянут лицензионных вопросов, не грузятся из сети и
// выглядят одинаково в любой сборке. Цвета палитры интерфейса:
// зелёный primary (#059669), янтарный акцент (#d97706), кремовый фон.
const P = '#059669';
const A = '#d97706';

const PATHS: Record<string, React.ReactNode> = {
  dairy: (
    <>
      <path d="M7 8h10l-1 11a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2L7 8z" />
      <path d="M17 10h2a3 3 0 0 1 0 6h-2" />
    </>
  ),
  'dairy-milk': (
    <>
      <path d="M8 7h8l-1 12a1.5 1.5 0 0 1-1.5 1.4h-3A1.5 1.5 0 0 1 9 19L8 7z" />
      <path d="M9 4h6" />
    </>
  ),
  'dairy-fermented': (
    <>
      <path d="M7 9h10l-.8 10.2a1.5 1.5 0 0 1-1.5 1.3h-5.4a1.5 1.5 0 0 1-1.5-1.3L7 9z" />
      <path d="M10 6V4M14 6V4" />
    </>
  ),
  'dairy-cheese': (
    <>
      <path d="M4 15l9-6 7 5-9 6-7-5z" />
      <circle cx="11" cy="14" r="1" />
      <circle cx="15" cy="12" r="1" />
    </>
  ),
  'dairy-butter': (
    <>
      <rect x="4" y="11" width="16" height="8" rx="1.5" />
      <path d="M4 14h16" />
    </>
  ),
  bakery: (
    <>
      <path d="M5 11a7 7 0 0 1 14 0v1H5v-1z" />
      <path d="M4 12h16v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-6z" />
    </>
  ),
  'bakery-bread': (
    <>
      <path d="M4 12a8 4 0 0 1 16 0v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-5z" />
      <path d="M8 14h8" />
    </>
  ),
  meat: (
    <>
      <path d="M8 5c4 1 6 3 6 6s-1 6-5 7c-2 .5-4-.5-4-3S4 8 8 5z" />
      <path d="M15 10c2 0 3 1.5 3 3s-1 3-3 3" />
    </>
  ),
  'meat-chicken': (
    <>
      <path d="M14 4c2 1 3 3 3 5l-4 4-3-3 4-6z" />
      <path d="M10 10L5 15l4 4 5-5" />
    </>
  ),
  sausage: (
    <>
      <path d="M6 8h9a4 4 0 0 1 0 8H6a4 4 0 0 1 0-8z" />
      <path d="M15 10h3a2 2 0 0 1 0 4h-3" />
    </>
  ),
  vegetables: (
    <>
      <path d="M12 21c4 0 6-3 6-7 0-3-2-5-6-5s-6 2-6 5c0 4 2 7 6 7z" />
      <path d="M12 9V5M12 6c1.5 0 2.5-.8 2.5-2.5" />
    </>
  ),
  fruit: (
    <>
      <path d="M12 8a6 6 0 1 1 0 12 6 6 0 0 1 0-12z" />
      <path d="M12 8c0-2 1-3 3-3" />
    </>
  ),
  groceries: (
    <>
      <path d="M5 8h14l-1.2 10.2a1.5 1.5 0 0 1-1.5 1.3H7.7a1.5 1.5 0 0 1-1.5-1.3L5 8z" />
      <path d="M9 8V6a3 3 0 0 1 6 0v2" />
    </>
  ),
  'groceries-flour': (
    <>
      <path d="M8 7h8l-1 12a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1L8 7z" />
      <path d="M8 11h8M8 15h8" />
    </>
  ),
  drinks: (
    <>
      <path d="M8 4h8l-1 4v11a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1V8L8 4z" />
      <path d="M8 11h8" />
    </>
  ),
  household: (
    <>
      <path d="M5 12l3-4h8l3 4v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-7z" />
      <path d="M9 20v-5h6v5" />
    </>
  ),
  __unassigned__: (
    <>
      <path d="M4 7h16M4 12h10M4 17h13" />
    </>
  ),
};

export function CategoryIcon({
  id,
  className,
  accent = false,
}: {
  id: string;
  className?: string;
  accent?: boolean;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke={accent ? A : P}
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {PATHS[id] ?? PATHS.__unassigned__}
    </svg>
  );
}
