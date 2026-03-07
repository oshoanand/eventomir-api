import prisma from "../libs/prisma.js";

const MOCK_EVENTS = [
  {
    id: "mock-1",
    organizerName: "Шеф-повар Александр",
    title: "Стейки и вино",
    description:
      "Изучим все тонкости прожарки и подбора вина к мясу. Группа до 10 человек. В стоимость включены все продукты и дегустация 3 сортов вина.",
    category: "Мастер-класс",
    date: new Date(Date.now() + 86400000 * 2), // Через 2 дня
    time: "19:00",
    city: "Москва",
    address: "Кулинарная студия 'Вкус', ул. Арбат 1",
    price: 4500,
    totalTickets: 10,
    availableTickets: 4,
    imageUrl: "https://picsum.photos/seed/food/800/600",
    status: "active",
  },
  {
    id: "mock-2",
    organizerName: "DJ Vibe",
    title: "Sunset Deep House Session",
    description:
      "Вечеринка на закате с лучшим видом на Неву. Только качественный звук и авторские коктейли от барменов.",
    category: "Вечеринка",
    date: new Date(Date.now() + 86400000 * 5),
    time: "20:00",
    city: "Санкт-Петербург",
    address: "Крыша 'Loft', П.С. 15",
    price: 1200,
    totalTickets: 150,
    availableTickets: 87,
    imageUrl: "https://picsum.photos/seed/music/800/600",
    status: "active",
  },
  {
    id: "mock-3",
    organizerName: "Фото-Агентство 'Кадр'",
    title: "Прогулка по старой Москве",
    description:
      "Учимся ловить свет и находить ракурсы в историческом центре. Идеально для тех, кто хочет обновить портфолио в соцсетях.",
    category: "Фото-прогулка",
    date: new Date(Date.now() + 86400000 * 3),
    time: "11:00",
    city: "Москва",
    address: "Чистые пруды",
    price: 2500,
    totalTickets: 8,
    availableTickets: 3,
    imageUrl: "https://picsum.photos/seed/art/800/600",
    status: "active",
  },
  {
    id: "mock-4",
    organizerName: "StandUp Club",
    title: "Вечер открытого микрофона",
    description:
      "Проверка новых шуток от лучших комиков города. Приходите поддержать начинающих и посмеяться над мэтрами.",
    category: "Стендап",
    date: new Date(Date.now() + 86400000 * 1),
    time: "21:00",
    city: "Екатеринбург",
    address: "Бар 'Шутка', ул. 8 Марта 12",
    price: 500,
    totalTickets: 50,
    availableTickets: 12,
    imageUrl: "https://picsum.photos/seed/standup/800/600",
    status: "active",
  },
];

async function main() {
  console.log(`🌱 Start seeding...`);

  const dummyHost = await prisma.user.upsert({
    where: { email: "host@eventomir.com" },
    update: {},
    create: {
      email: "host@eventomir.com",
      name: "Eventomir Organizer",
      password: "Test1234",
    },
  });

  console.log(`👤 Created dummy host user with ID: ${dummyHost.id}`);

  // Insert Events
  for (const event of MOCK_EVENTS) {
    await prisma.event.upsert({
      where: { id: event.id },
      update: {
        // If it already exists, update the date so it doesn't stay in the past
        date: event.date,
        availableTickets: event.availableTickets,
      },
      create: {
        id: event.id,
        title: event.title,
        description: event.description,
        category: event.category,
        date: event.date,
        time: event.time,
        city: event.city,
        address: event.address,
        price: event.price,
        totalTickets: event.totalTickets,
        availableTickets: event.availableTickets,
        imageUrl: event.imageUrl,
        status: event.status,
        hostId: dummyHost.id,
      },
    });
    console.log(`✅ Created event: ${event.title}`);
  }

  console.log(`🎉 Seeding finished successfully.`);
}

main()
  .catch((e) => {
    console.error("❌ Seeding failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
