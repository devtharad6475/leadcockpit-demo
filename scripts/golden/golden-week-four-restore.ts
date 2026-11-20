import "./_helpers/isolate-standalone";
import {createJsonRepos} from "./_helpers/provider";
import {checkWeekFourRestore} from "./_helpers/week-four-restore-contract";
checkWeekFourRestore(createJsonRepos()).catch(error => {console.error(error); process.exitCode = 1;});
