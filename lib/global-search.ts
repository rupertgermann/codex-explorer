export type SearchableDatabase = {
  id: string;
  name: string;
  filename: string;
  relativePath: string;
  group: string;
  tables: {
    name: string;
    columns: { name: string; type: string }[];
    indexes: string[];
  }[];
};

export type DatabaseSearchResult = {
  databaseId: string;
  name: string;
  relativePath: string;
  matches: string[];
};

export function searchDatabaseCatalog(databases: SearchableDatabase[], query: string): DatabaseSearchResult[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];

  return databases.flatMap((database) => {
    const matches: string[] = [];
    const add = (label: string, value: string) => {
      if (value.toLocaleLowerCase().includes(needle)) matches.push(label);
    };

    add(`Database · ${database.filename}`, `${database.name} ${database.filename} ${database.relativePath} ${database.group}`);
    database.tables.forEach((table) => {
      add(`Table · ${table.name}`, table.name);
      table.columns.forEach((column) => add(`Column · ${table.name}.${column.name} (${column.type || "ANY"})`, `${column.name} ${column.type}`));
      table.indexes.forEach((index) => add(`Index · ${table.name}.${index}`, index));
    });

    return matches.length > 0
      ? [{ databaseId: database.id, name: database.name, relativePath: database.relativePath, matches: matches.slice(0, 8) }]
      : [];
  }).slice(0, 20);
}
