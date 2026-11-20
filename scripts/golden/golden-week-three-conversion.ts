import "./_helpers/isolate-standalone";
import { createRepositories } from "@/repositories";
import { checkWeekThreeConversions } from "./_helpers/week-three-conversion-contract";

checkWeekThreeConversions(createRepositories("json")).then(() => {
  console.log("Week three atomic quote conversion JSON: PASS");
}).catch(error => { console.error(error); process.exitCode = 1; });
